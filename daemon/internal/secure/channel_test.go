package secure

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
)

// miniRelay is a minimal in-process relay supporting one device and multiple
// clients so secure.Manager + transport.Client can be tested end-to-end.
type miniRelay struct {
	srv     *httptest.Server
	relayID string

	mu      sync.Mutex
	device  *websocket.Conn
	clients map[string]*websocket.Conn
	seq     int
	seen    [][]byte // raw frame payloads observed by relay
}

func newMiniRelay(t *testing.T) *miniRelay {
	t.Helper()
	r := &miniRelay{
		relayID: "agentik-relay-test",
		clients: make(map[string]*websocket.Conn),
	}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(func() {
		r.mu.Lock()
		if r.device != nil {
			_ = r.device.Close(websocket.StatusNormalClosure, "bye")
		}
		for _, c := range r.clients {
			_ = c.Close(websocket.StatusNormalClosure, "bye")
		}
		r.mu.Unlock()
		r.srv.Close()
	})
	return r
}

func (r *miniRelay) wsURL() string {
	return "ws" + strings.TrimPrefix(r.srv.URL, "http")
}

func (r *miniRelay) serve(w http.ResponseWriter, req *http.Request) {
	ws, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(64 * 1024)
	ctx := req.Context()

	chal := make([]byte, protocol.ChallengeSize)
	_, _ = rand.Read(chal)
	_ = writeJSON(ctx, ws, map[string]any{
		"type":      "challenge",
		"challenge": base64.StdEncoding.EncodeToString(chal),
		"relayId":   r.relayID,
		"expiresAt": time.Now().Add(time.Minute).Unix(),
	})

	role := ""
	connID := ""
	defer func() {
		if role == "client" && connID != "" {
			r.mu.Lock()
			delete(r.clients, connID)
			dev := r.device
			r.mu.Unlock()
			if dev != nil {
				_ = writeJSON(context.Background(), dev, map[string]any{
					"type":         "peer_state",
					"connectionId": connID,
					"present":      false,
				})
			}
		}
	}()

	for {
		mt, raw, err := ws.Read(ctx)
		if err != nil || mt != websocket.MessageText {
			return
		}
		if string(raw) == transport.KeepalivePing {
			_ = writeJSON(ctx, ws, map[string]any{"type": "pong"})
			continue
		}
		var env map[string]any
		if err := json.Unmarshal(raw, &env); err != nil {
			return
		}
		switch env["type"] {
		case "register":
			role = "device"
			r.mu.Lock()
			r.device = ws
			waiting := make([]string, 0, len(r.clients))
			for id := range r.clients {
				waiting = append(waiting, id)
			}
			r.mu.Unlock()
			_ = writeJSON(ctx, ws, map[string]any{
				"type":        "registered",
				"deviceId":    req.URL.Query().Get("device"),
				"connections": waiting,
			})
		case "attach":
			role = "client"
			r.mu.Lock()
			r.seq++
			connID = strings.Repeat("0", 30) + string(rune('a'+r.seq/16)) + string(rune('a'+r.seq%16))
			r.clients[connID] = ws
			dev := r.device
			r.mu.Unlock()
			_ = writeJSON(ctx, ws, map[string]any{
				"type":          "attached",
				"deviceId":      req.URL.Query().Get("device"),
				"connectionId":  connID,
				"devicePresent": dev != nil,
			})
			if dev != nil {
				_ = writeJSON(ctx, dev, map[string]any{
					"type":         "peer_state",
					"connectionId": connID,
					"present":      true,
				})
			}
		case "frame":
			dataStr, _ := env["data"].(string)
			rawBytes, _ := base64.StdEncoding.DecodeString(dataStr)
			r.mu.Lock()
			r.seen = append(r.seen, rawBytes)
			r.mu.Unlock()

			if role == "client" {
				r.mu.Lock()
				dev := r.device
				r.mu.Unlock()
				if dev != nil {
					_ = writeJSON(ctx, dev, map[string]any{
						"type":         "frame",
						"connectionId": connID,
						"data":         dataStr,
					})
				}
			} else if role == "device" {
				targetID, _ := env["connection_id"].(string)
				r.mu.Lock()
				target := r.clients[targetID]
				r.mu.Unlock()
				if target != nil {
					_ = writeJSON(ctx, target, map[string]any{
						"type": "frame",
						"data": dataStr,
					})
				}
			}
		}
	}
}

func writeJSON(ctx context.Context, ws *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageText, b)
}

type testPhone struct {
	ws      *websocket.Conn
	connID  string
	session *Session
}

func connectTestPhone(
	t *testing.T,
	ctx context.Context,
	relayURL string,
	devID *identity.Identity,
	phonePriv *ecdh.PrivateKey,
	pinnedDevicePub []byte,
) (*testPhone, error) {
	t.Helper()
	u := strings.TrimRight(relayURL, "/") + "/v1/connect?device=" + devID.DeviceIDString()
	ws, _, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(64 * 1024)

	// Read challenge.
	_, _, err = ws.Read(ctx)
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	if err := writeJSON(ctx, ws, map[string]any{
		"type":      "attach",
		"version":   protocol.Version,
		"device_id": base64.StdEncoding.EncodeToString(devID.DeviceID()),
	}); err != nil {
		_ = ws.CloseNow()
		return nil, err
	}

	var connID string
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			_ = ws.CloseNow()
			return nil, err
		}
		var msg map[string]any
		_ = json.Unmarshal(raw, &msg)
		if msg["type"] == "attached" {
			connID, _ = msg["connectionId"].(string)
			break
		}
	}

	hs, err := NewHandshake(Config{
		Initiator: true,
		StaticKey: phonePriv,
		Prologue:  DevicePrologue(devID.DeviceID()),
		VerifyPeer: func(peerStatic []byte) error {
			if !protocol.ConstantTimeEqual(peerStatic, pinnedDevicePub) {
				return errors.New("device pin mismatch")
			}
			return nil
		},
	})
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}

	// Send XX msg1 -> e
	msg1, err := hs.WriteMessage(nil)
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	if err := writeJSON(ctx, ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(msg1),
	}); err != nil {
		_ = ws.CloseNow()
		return nil, err
	}

	// Wait for XX msg2 <- e, ee, s, es
	var msg2 []byte
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			_ = ws.CloseNow()
			return nil, err
		}
		var env map[string]any
		_ = json.Unmarshal(raw, &env)
		if env["type"] == "frame" {
			s, _ := env["data"].(string)
			msg2, _ = base64.StdEncoding.DecodeString(s)
			break
		}
	}
	if _, err := hs.ReadMessage(msg2); err != nil {
		_ = ws.CloseNow()
		return nil, err
	}

	// Send XX msg3 -> s, se
	msg3, err := hs.WriteMessage(nil)
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	if err := writeJSON(ctx, ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(msg3),
	}); err != nil {
		_ = ws.CloseNow()
		return nil, err
	}

	sess, err := hs.Session()
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	return &testPhone{ws: ws, connID: connID, session: sess}, nil
}

func (p *testPhone) sendEncrypted(ctx context.Context, plaintext []byte) ([]byte, error) {
	ct, err := p.session.Encrypt(plaintext)
	if err != nil {
		return nil, err
	}
	if err := writeJSON(ctx, p.ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(ct),
	}); err != nil {
		return nil, err
	}
	return ct, nil
}

func (p *testPhone) recvDecrypted(ctx context.Context) ([]byte, error) {
	for {
		_, raw, err := p.ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		var env map[string]any
		_ = json.Unmarshal(raw, &env)
		if env["type"] != "frame" {
			continue
		}
		s, _ := env["data"].(string)
		ct, _ := base64.StdEncoding.DecodeString(s)
		return p.session.Decrypt(ct)
	}
}

func startDaemonStack(
	t *testing.T,
	ctx context.Context,
	relayURL string,
	devID *identity.Identity,
	trustedKey []byte,
) (*Manager, *transport.Client, chan *ManagedSession, chan []byte, chan error) {
	t.Helper()
	readyCh := make(chan *ManagedSession, 4)
	msgCh := make(chan []byte, 8)
	errCh := make(chan error, 8)
	regDone := make(chan struct{}, 1)

	var client *transport.Client
	var mgr *Manager
	var err error

	// Wrap transport.Client as FrameSender once constructed.
	sender := senderFunc(func(sctx context.Context, connID string, data []byte) error {
		return client.SendFrame(sctx, connID, data)
	})

	mgr, err = NewManager(ManagerConfig{
		DeviceID:  devID.DeviceID(),
		StaticKey: devID.NoisePrivateKey(),
		Sender:    sender,
		VerifyPeer: func(_ context.Context, _ string, clientStatic []byte) error {
			if !protocol.ConstantTimeEqual(clientStatic, trustedKey) {
				return errors.New("client static key not pinned")
			}
			return nil
		},
		OnSessionReady: func(_ context.Context, s *ManagedSession) {
			readyCh <- s
		},
		OnMessage: func(_ context.Context, _ *ManagedSession, pt []byte) {
			msgCh <- bytes.Clone(pt)
		},
		OnError: func(_ string, err error) {
			errCh <- err
		},
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	client, err = transport.NewClient(transport.Config{
		RelayURL:     relayURL,
		Identity:     devID,
		PingInterval: time.Minute,
		Handlers: transport.Handlers{
			OnRegistered: func(_ string, conns []string) {
				mgr.HandleRegistered(ctx, conns)
				select {
				case regDone <- struct{}{}:
				default:
				}
			},
			OnDisconnected: func() {
				mgr.HandleDisconnected()
			},
			OnPeerState: func(connID string, present bool) {
				mgr.HandlePeerState(ctx, connID, present)
			},
			OnFrame: func(connID string, data []byte) {
				mgr.HandleFrame(ctx, connID, data)
			},
		},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	go func() { _ = client.Run(ctx) }()

	select {
	case <-regDone:
	case <-time.After(3 * time.Second):
		t.Fatal("daemon failed to register with miniRelay")
	}
	return mgr, client, readyCh, msgCh, errCh
}

type senderFunc func(context.Context, string, []byte) error

func (f senderFunc) SendFrame(ctx context.Context, connID string, data []byte) error {
	return f(ctx, connID, data)
}

func TestNoiseOverTransport_HandshakeSuccessAndRelayOpacity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	relay := newMiniRelay(t)
	devID, _ := identity.Generate()
	phoneKey := newStatic(t)

	_, _, readyCh, msgCh, errCh := startDaemonStack(t, ctx, relay.wsURL(), devID, phoneKey.PublicKey().Bytes())

	phone, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatalf("connectTestPhone: %v", err)
	}
	defer phone.ws.CloseNow()

	var daemonSess *ManagedSession
	select {
	case daemonSess = <-readyCh:
	case err := <-errCh:
		t.Fatalf("unexpected daemon noise error: %v", err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for daemon session")
	}

	secretPrompt := []byte(`{"v":1,"request_id":"r1","method":"task.start","params":{"prompt":"super secret prompt"}}`)
	if _, err := phone.sendEncrypted(ctx, secretPrompt); err != nil {
		t.Fatalf("phone sendEncrypted: %v", err)
	}

	select {
	case got := <-msgCh:
		if !bytes.Equal(got, secretPrompt) {
			t.Fatalf("daemon decrypted = %q, want %q", got, secretPrompt)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for decrypted message")
	}

	reply := []byte(`{"v":1,"request_id":"r1","ok":true}`)
	if err := daemonSess.Send(ctx, reply); err != nil {
		t.Fatalf("daemon Send: %v", err)
	}
	gotReply, err := phone.recvDecrypted(ctx)
	if err != nil {
		t.Fatalf("phone recvDecrypted: %v", err)
	}
	if !bytes.Equal(gotReply, reply) {
		t.Fatalf("phone decrypted = %q, want %q", gotReply, reply)
	}

	// Ensure relay never saw plaintext prompt or reply.
	relay.mu.Lock()
	for _, raw := range relay.seen {
		if bytes.Contains(raw, []byte("super secret prompt")) || bytes.Contains(raw, []byte(`"ok":true`)) {
			t.Fatal("relay saw plaintext frame payload")
		}
	}
	relay.mu.Unlock()
}

func TestNoiseOverTransport_WrongPinRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	relay := newMiniRelay(t)
	devID, _ := identity.Generate()
	trustedPhone := newStatic(t)
	attackerPhone := newStatic(t)

	_, _, readyCh, msgCh, errCh := startDaemonStack(t, ctx, relay.wsURL(), devID, trustedPhone.PublicKey().Bytes())

	// 1. Unknown/unpinned phone connects: responder rejects at msg3.
	attacker, err := connectTestPhone(t, ctx, relay.wsURL(), devID, attackerPhone, devID.NoisePublicKey())
	if err == nil {
		// Initiator completes msg3 write, then responder rejects msg3.
		_, _ = attacker.sendEncrypted(ctx, []byte("unauthorized command"))
		_ = attacker.ws.CloseNow()
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrPeerRejected) {
			t.Fatalf("expected ErrPeerRejected, got %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for ErrPeerRejected")
	}

	select {
	case <-readyCh:
		t.Fatal("untrusted client created a session")
	case <-msgCh:
		t.Fatal("untrusted client delivered a message")
	case <-time.After(80 * time.Millisecond):
	}

	// 2. Trusted phone with wrong pinned device key aborts at msg2.
	wrongDeviceKey := newStatic(t).PublicKey().Bytes()
	if _, err := connectTestPhone(t, ctx, relay.wsURL(), devID, trustedPhone, wrongDeviceKey); !errors.Is(err, ErrPeerRejected) {
		t.Fatalf("wrong device pin: got %v, want ErrPeerRejected", err)
	}
}

func TestNoiseOverTransport_ReplayRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	relay := newMiniRelay(t)
	devID, _ := identity.Generate()
	phoneKey := newStatic(t)

	_, _, readyCh, msgCh, errCh := startDaemonStack(t, ctx, relay.wsURL(), devID, phoneKey.PublicKey().Bytes())

	phone, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer phone.ws.CloseNow()
	<-readyCh

	firstMsg := []byte("first-and-only")
	capturedCT, err := phone.sendEncrypted(ctx, firstMsg)
	if err != nil {
		t.Fatal(err)
	}
	if got := <-msgCh; !bytes.Equal(got, firstMsg) {
		t.Fatalf("got %q, want %q", got, firstMsg)
	}

	// Replay exact ciphertext over the same connection.
	if err := writeJSON(ctx, phone.ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(capturedCT),
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("unexpected error on replay: %v", err)
		}
	case got := <-msgCh:
		t.Fatalf("replayed ciphertext was decrypted: %q", got)
	case <-ctx.Done():
		t.Fatal("timed out waiting for replay rejection")
	}
}

func TestNoiseOverTransport_CrossSessionIncompatibility(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	relay := newMiniRelay(t)
	devID, _ := identity.Generate()
	phoneKey := newStatic(t)

	_, _, readyCh, msgCh, errCh := startDaemonStack(t, ctx, relay.wsURL(), devID, phoneKey.PublicKey().Bytes())

	// Session 1: encrypt a ciphertext.
	phone1, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatal(err)
	}
	<-readyCh
	oldCT, err := phone1.session.Encrypt([]byte("old-session-command"))
	if err != nil {
		t.Fatal(err)
	}
	_ = phone1.ws.Close(websocket.StatusNormalClosure, "reconnect")

	// Session 2: fresh handshake with the exact same keys.
	phone2, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer phone2.ws.CloseNow()
	<-readyCh

	// Inject ciphertext from Session 1 into Session 2 -> must fail.
	if err := writeJSON(ctx, phone2.ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(oldCT),
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("expected decrypt error on cross-session frame, got %v", err)
		}
	case got := <-msgCh:
		t.Fatalf("cross-session ciphertext accepted: %q", got)
	case <-ctx.Done():
		t.Fatal("timed out waiting for cross-session rejection")
	}
}

func TestNoiseOverTransport_PerConnectionIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	relay := newMiniRelay(t)
	devID, _ := identity.Generate()
	phoneKey := newStatic(t)

	_, _, readyCh, msgCh, errCh := startDaemonStack(t, ctx, relay.wsURL(), devID, phoneKey.PublicKey().Bytes())

	phoneA, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer phoneA.ws.CloseNow()
	<-readyCh

	phoneB, err := connectTestPhone(t, ctx, relay.wsURL(), devID, phoneKey, devID.NoisePublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer phoneB.ws.CloseNow()
	<-readyCh

	ctFromA, err := phoneA.session.Encrypt([]byte("for-connection-A-only"))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(ctx, phoneB.ws, map[string]any{
		"type": "frame",
		"data": base64.StdEncoding.EncodeToString(ctFromA),
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("expected decrypt error across connections, got %v", err)
		}
	case got := <-msgCh:
		t.Fatalf("frame encrypted on conn A decrypted on conn B: %q", got)
	case <-ctx.Done():
		t.Fatal("timed out waiting for cross-connection rejection")
	}
}
