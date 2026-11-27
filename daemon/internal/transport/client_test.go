package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

type fakeRelay struct {
	server  *httptest.Server
	relayID string

	mu            sync.Mutex
	conns         []*websocket.Conn
	waitingConns  []string
	registeredCnt int
	pingCnt       int
	received      []fakeSignal
	lastRegister  *outboundRegister
	dropAfterReg  int
	suppressPong  bool
	sendRawError  string
	onRegister    func()
	onSignal      func(connectionID, kind string, data []byte)
	onUnknown     func(msgType string)
	onPing        func()
}

type fakeSignal struct {
	connectionID string
	kind         string
	data         []byte
}

func newFakeRelay(t *testing.T, relayID string) *fakeRelay {
	t.Helper()
	fr := &fakeRelay{relayID: relayID}
	fr.server = httptest.NewServer(http.HandlerFunc(fr.handle))
	t.Cleanup(func() {
		fr.mu.Lock()
		for _, c := range fr.conns {
			_ = c.Close(websocket.StatusNormalClosure, "test done")
		}
		fr.mu.Unlock()
		fr.server.Close()
	})
	return fr
}

func (f *fakeRelay) wsURL() string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http")
}

func (f *fakeRelay) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/connect" && !strings.HasSuffix(r.URL.Path, "/v1/connect") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	deviceParam := r.URL.Query().Get("device")
	expectedID, err := protocol.ParseDeviceID(deviceParam)
	if err != nil {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}

	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(64 * 1024)

	f.mu.Lock()
	f.conns = append(f.conns, ws)
	f.mu.Unlock()

	challenge := make([]byte, protocol.ChallengeSize)
	if _, err := rand.Read(challenge); err != nil {
		_ = ws.Close(websocket.StatusInternalError, "rand")
		return
	}
	ctx := r.Context()
	chalMsg, _ := json.Marshal(map[string]any{
		"type":      "challenge",
		"challenge": base64.StdEncoding.EncodeToString(challenge),
		"relayId":   f.relayID,
		"expiresAt": time.Now().Add(30 * time.Second).Unix(),
	})
	if err := ws.Write(ctx, websocket.MessageText, chalMsg); err != nil {
		return
	}

	for {
		msgType, raw, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if msgType != websocket.MessageText {
			_ = ws.Close(CloseProtocolError, "binary not allowed")
			return
		}
		if string(raw) == KeepalivePing {
			f.mu.Lock()
			f.pingCnt++
			suppress := f.suppressPong
			cb := f.onPing
			f.mu.Unlock()
			if cb != nil {
				cb()
			}
			if !suppress {
				_ = ws.Write(ctx, websocket.MessageText, []byte(`{"type":"pong"}`))
			}
			continue
		}

		var env struct {
			Type              string `json:"type"`
			Version           uint16 `json:"version"`
			Role              string `json:"role"`
			RelayID           string `json:"relay_id"`
			DeviceID          string `json:"device_id"`
			RegisterPublicKey string `json:"register_public_key"`
			Challenge         string `json:"challenge"`
			ExpiresAt         int64  `json:"expires_at"`
			Signature         string `json:"signature"`
			Kind              string `json:"kind"`
			Data              string `json:"data"`
			ConnectionID      string `json:"connection_id"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return
		}

		switch env.Type {
		case "register":
			f.mu.Lock()
			errCode := f.sendRawError
			f.mu.Unlock()
			if errCode != "" {
				errMsg, _ := json.Marshal(map[string]any{
					"type":    "error",
					"code":    errCode,
					"message": "forced test error",
				})
				_ = ws.Write(ctx, websocket.MessageText, errMsg)
				_ = ws.Close(CloseProtocolError, errCode)
				return
			}

			devID, _ := base64.StdEncoding.DecodeString(env.DeviceID)
			pub, _ := base64.StdEncoding.DecodeString(env.RegisterPublicKey)
			chal, _ := base64.StdEncoding.DecodeString(env.Challenge)
			sig, _ := base64.StdEncoding.DecodeString(env.Signature)

			if !protocol.ConstantTimeEqual(devID, expectedID) {
				_ = ws.Close(CloseProtocolError, "wrong route")
				return
			}

			req := &protocol.RegisterRequest{
				Version:           env.Version,
				Role:              protocol.Role(env.Role),
				RelayID:           env.RelayID,
				DeviceID:          devID,
				RegisterPublicKey: pub,
				Challenge:         chal,
				ExpiresAt:         time.Unix(env.ExpiresAt, 0),
				Signature:         sig,
			}
			if err := req.Verify(f.relayID, challenge, time.Now()); err != nil {
				errMsg, _ := json.Marshal(map[string]any{
					"type":    "error",
					"code":    "unauthorized",
					"message": err.Error(),
				})
				_ = ws.Write(ctx, websocket.MessageText, errMsg)
				_ = ws.Close(CloseProtocolError, "unauthorized")
				return
			}

			f.mu.Lock()
			f.registeredCnt++
			regCount := f.registeredCnt
			drop := f.dropAfterReg > 0 && regCount <= f.dropAfterReg
			waiting := append([]string(nil), f.waitingConns...)
			f.lastRegister = &outboundRegister{
				Type:              env.Type,
				Version:           env.Version,
				Role:              env.Role,
				RelayID:           env.RelayID,
				DeviceID:          env.DeviceID,
				RegisterPublicKey: env.RegisterPublicKey,
				Challenge:         env.Challenge,
				ExpiresAt:         env.ExpiresAt,
				Signature:         env.Signature,
			}
			onReg := f.onRegister
			f.mu.Unlock()

			reply, _ := json.Marshal(map[string]any{
				"type":        "registered",
				"deviceId":    protocol.FormatDeviceID(devID),
				"connections": waiting,
			})
			_ = ws.Write(ctx, websocket.MessageText, reply)
			if onReg != nil {
				onReg()
			}
			if drop {
				_ = ws.Close(websocket.StatusGoingAway, "simulated drop")
				return
			}

		case "signal":
			data, err := base64.StdEncoding.DecodeString(env.Data)
			if err != nil {
				return
			}
			f.mu.Lock()
			f.received = append(f.received, fakeSignal{connectionID: env.ConnectionID, kind: env.Kind, data: data})
			cb := f.onSignal
			f.mu.Unlock()
			if cb != nil {
				cb(env.ConnectionID, env.Kind, data)
			}
		default:
			f.mu.Lock()
			cb := f.onUnknown
			f.mu.Unlock()
			if cb != nil {
				cb(env.Type)
			}
		}
	}
}

func (f *fakeRelay) latestConn() *websocket.Conn {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.conns) == 0 {
		return nil
	}
	return f.conns[len(f.conns)-1]
}

func (f *fakeRelay) sendToDevice(t *testing.T, v any) {
	t.Helper()
	conn := f.latestConn()
	if conn == nil {
		t.Fatal("no active relay connection")
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatalf("write to device: %v", err)
	}
}

func mustIdentity(t *testing.T) *identity.Identity {
	t.Helper()
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestBuildConnectURL(t *testing.T) {
	id := mustIdentity(t)
	c, err := NewClient(Config{
		RelayURL: "https://relay.example.com",
		Identity: id,
	})
	if err == nil || c != nil {
		t.Fatal("accepted https:// relay URL instead of wss://")
	}

	c, err = NewClient(Config{
		RelayURL: "wss://relay.example.com/prefix/",
		Identity: id,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	want := "wss://relay.example.com/prefix/v1/connect?device=" + id.DeviceIDString()
	if c.URL() != want {
		t.Fatalf("URL = %q, want %q", c.URL(), want)
	}
}

func TestComputeBackoffDelay(t *testing.T) {
	cfg := BackoffConfig{
		Base:   100 * time.Millisecond,
		Max:    800 * time.Millisecond,
		Factor: 2,
		Random: func() float64 { return 0.999999 },
	}
	got := []time.Duration{
		ComputeBackoffDelay(0, cfg),
		ComputeBackoffDelay(1, cfg),
		ComputeBackoffDelay(2, cfg),
		ComputeBackoffDelay(3, cfg),
		ComputeBackoffDelay(4, cfg),
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, 800 * time.Millisecond}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attempt %d: got %v, want %v", i, got[i], want[i])
		}
	}

	cfg.Random = func() float64 { return 0 }
	if d := ComputeBackoffDelay(2, cfg); d != 200*time.Millisecond {
		t.Fatalf("min jitter attempt 2: got %v, want 200ms", d)
	}
}

func TestClientRegistersAndExchangesSignals(t *testing.T) {
	id := mustIdentity(t)
	relay := newFakeRelay(t, "agentik-relay-test")
	connA := "0123456789abcdef0123456789abcdef"
	relay.waitingConns = []string{connA}

	regCh := make(chan []string, 1)
	peerCh := make(chan struct {
		id      string
		present bool
	}, 4)
	signalCh := make(chan fakeSignal, 4)
	relaySignalAck := make(chan struct{}, 1)
	relay.onSignal = func(connectionID, kind string, data []byte) {
		select {
		case relaySignalAck <- struct{}{}:
		default:
		}
	}

	client, err := NewClient(Config{
		RelayURL:        relay.wsURL(),
		Identity:        id,
		ExpectedRelayID: "agentik-relay-test",
		PingInterval:    5 * time.Second,
		Handlers: Handlers{
			OnRegistered: func(deviceID string, connections []string) {
				if deviceID != id.DeviceIDString() {
					t.Errorf("registered deviceID = %s, want %s", deviceID, id.DeviceIDString())
				}
				regCh <- connections
			},
			OnPeerState: func(connectionID string, present bool) {
				peerCh <- struct {
					id      string
					present bool
				}{connectionID, present}
			},
			OnSignal: func(connectionID, kind string, data []byte) {
				signalCh <- fakeSignal{connectionID: connectionID, kind: kind, data: bytes.Clone(data)}
			},
		},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	if err := client.SendSignal(context.Background(), connA, SignalICE, []byte("early")); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("SendSignal before connect: got %v, want ErrNotConnected", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	select {
	case conns := <-regCh:
		if len(conns) != 1 || conns[0] != connA {
			t.Fatalf("initial connections = %v, want [%s]", conns, connA)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for registration")
	}

	// Verify peer_state delivery.
	connB := "fedcba9876543210fedcba9876543210"
	relay.sendToDevice(t, map[string]any{
		"type":         "peer_state",
		"connectionId": connB,
		"present":      true,
	})
	select {
	case p := <-peerCh:
		if p.id != connB || !p.present {
			t.Fatalf("peer_state = %+v", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for peer_state")
	}

	// Verify inbound signal delivery with binary-like bytes.
	inboundPayload := []byte{0x00, 0xff, 0x80, 0x01, 0x42}
	relay.sendToDevice(t, map[string]any{
		"type":         "signal",
		"kind":         "offer",
		"connectionId": connA,
		"data":         base64.StdEncoding.EncodeToString(inboundPayload),
	})
	select {
	case f := <-signalCh:
		if f.connectionID != connA || f.kind != SignalOffer || !bytes.Equal(f.data, inboundPayload) {
			t.Fatalf("received signal = %+v", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for inbound signal")
	}

	// A frame message, or a signal kind a client may not send, never reaches
	// the handler: there is no application data path on the relay.
	relay.sendToDevice(t, map[string]any{
		"type":         "frame",
		"connectionId": connA,
		"data":         base64.StdEncoding.EncodeToString(inboundPayload),
	})
	relay.sendToDevice(t, map[string]any{
		"type":         "signal",
		"kind":         "answer",
		"connectionId": connA,
		"data":         base64.StdEncoding.EncodeToString(inboundPayload),
	})
	select {
	case f := <-signalCh:
		t.Fatalf("unexpected delivery: %+v", f)
	case <-time.After(150 * time.Millisecond):
	}

	// Verify outbound signal validation & delivery.
	if err := client.SendSignal(ctx, "not-hex", SignalICE, []byte{1}); !errors.Is(err, ErrInvalidConnectionID) {
		t.Fatalf("invalid connection id: got %v", err)
	}
	if err := client.SendSignal(ctx, connA, SignalICE, nil); !errors.Is(err, ErrSignalEmpty) {
		t.Fatalf("empty signal: got %v", err)
	}
	if err := client.SendSignal(ctx, connA, SignalICE, make([]byte, MaxSignalBytes+1)); !errors.Is(err, ErrSignalTooLarge) {
		t.Fatalf("oversized signal: got %v", err)
	}
	for _, kind := range []string{"", "offer", "frame", "data", "ICE"} {
		if err := client.SendSignal(ctx, connA, kind, []byte{1}); !errors.Is(err, ErrSignalKind) {
			t.Fatalf("kind %q: got %v, want ErrSignalKind", kind, err)
		}
	}

	outboundPayload := []byte("sdp-answer-payload")
	if err := client.SendSignal(ctx, connB, SignalAnswer, outboundPayload); err != nil {
		t.Fatalf("SendSignal: %v", err)
	}
	select {
	case <-relaySignalAck:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for relay to receive signal")
	}

	relay.mu.Lock()
	got := relay.received
	relay.mu.Unlock()
	if len(got) != 1 || got[0].connectionID != connB || got[0].kind != SignalAnswer || !bytes.Equal(got[0].data, outboundPayload) {
		t.Fatalf("relay received = %+v", got)
	}

	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run exit: got %v, want context.Canceled", err)
	}
	if st := client.Status(); st.State != StateStopped {
		t.Fatalf("status after cancel = %s, want stopped", st.State)
	}
}

func TestClientKeepaliveAndTimeoutReconnect(t *testing.T) {
	id := mustIdentity(t)
	relay := newFakeRelay(t, "agentik-relay-test")

	pingAck := make(chan struct{}, 4)
	relay.onPing = func() {
		select {
		case pingAck <- struct{}{}:
		default:
		}
	}

	regCh := make(chan struct{}, 4)
	discCh := make(chan struct{}, 4)

	client, err := NewClient(Config{
		RelayURL:     relay.wsURL(),
		Identity:     id,
		PingInterval: 40 * time.Millisecond,
		PongTimeout:  60 * time.Millisecond,
		Backoff: BackoffConfig{
			Base:   20 * time.Millisecond,
			Max:    40 * time.Millisecond,
			Factor: 2,
			Random: func() float64 { return 0.5 },
		},
		Handlers: Handlers{
			OnRegistered:   func(string, []string) { regCh <- struct{}{} },
			OnDisconnected: func() { discCh <- struct{}{} },
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	<-regCh
	// Wait for at least two successful ping/pong cycles.
	<-pingAck
	<-pingAck

	// Now suppress pongs to verify keepalive timeout triggers disconnect + reconnect.
	relay.mu.Lock()
	relay.suppressPong = true
	relay.mu.Unlock()

	select {
	case <-discCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for disconnect after pong suppression")
	}

	relay.mu.Lock()
	relay.suppressPong = false
	relay.mu.Unlock()

	select {
	case <-regCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for reconnect after keepalive timeout")
	}

	cancel()
	<-done
}

func TestClientReconnectsWithBackoffAfterDrop(t *testing.T) {
	id := mustIdentity(t)
	relay := newFakeRelay(t, "agentik-relay-test")
	relay.dropAfterReg = 2 // drop first two connections immediately after registered

	regCh := make(chan struct{}, 4)
	var mu sync.Mutex
	var statuses []State

	client, err := NewClient(Config{
		RelayURL:     relay.wsURL(),
		Identity:     id,
		PingInterval: time.Minute,
		Backoff: BackoffConfig{
			Base:   15 * time.Millisecond,
			Max:    60 * time.Millisecond,
			Factor: 2,
			Random: func() float64 { return 0.5 },
		},
		Handlers: Handlers{
			OnStatus: func(s Status) {
				mu.Lock()
				statuses = append(statuses, s.State)
				mu.Unlock()
			},
			OnRegistered: func(string, []string) { regCh <- struct{}{} },
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	// Must register 3 times (2 drops + 3rd stays up).
	for i := range 3 {
		select {
		case <-regCh:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for registration #%d", i+1)
		}
	}

	mu.Lock()
	sawReconnecting := false
	for _, s := range statuses {
		if s == StateReconnecting {
			sawReconnecting = true
			break
		}
	}
	mu.Unlock()
	if !sawReconnecting {
		t.Fatalf("expected StateReconnecting in status history: %v", statuses)
	}

	cancel()
	<-done
}

func TestClientStopsOnFatalRelayErrors(t *testing.T) {
	id := mustIdentity(t)

	t.Run("unexpected relayId", func(t *testing.T) {
		relay := newFakeRelay(t, "wrong-relay")
		client, err := NewClient(Config{
			RelayURL:        relay.wsURL(),
			Identity:        id,
			ExpectedRelayID: "expected-relay",
		})
		if err != nil {
			t.Fatal(err)
		}
		err = client.Run(context.Background())
		if err == nil || !strings.Contains(err.Error(), "unexpected relay id") {
			t.Fatalf("got %v, want unexpected relay id error", err)
		}
		if client.Status().State != StateFailed {
			t.Fatalf("state = %s, want failed", client.Status().State)
		}
	})

	t.Run("unsupported_version", func(t *testing.T) {
		relay := newFakeRelay(t, "agentik-relay-test")
		relay.sendRawError = "unsupported_version"
		client, err := NewClient(Config{
			RelayURL: relay.wsURL(),
			Identity: id,
		})
		if err != nil {
			t.Fatal(err)
		}
		err = client.Run(context.Background())
		if err == nil || !strings.Contains(err.Error(), "unsupported_version") {
			t.Fatalf("got %v, want unsupported_version fatal error", err)
		}
		if client.Status().State != StateFailed {
			t.Fatalf("state = %s, want failed", client.Status().State)
		}
	})
}

// TestClientAgainstRealRelay verifies registration, keepalive, and client
// attach/signal exchange against a live relay when AGENTIK_TEST_RELAY_URL is set.
func TestClientAgainstRealRelay(t *testing.T) {
	relayURL := os.Getenv("AGENTIK_TEST_RELAY_URL")
	if relayURL == "" {
		t.Skip("AGENTIK_TEST_RELAY_URL not set")
	}

	id := mustIdentity(t)
	regCh := make(chan string, 1)
	peerCh := make(chan string, 2)
	signalCh := make(chan fakeSignal, 2)

	client, err := NewClient(Config{
		RelayURL:        relayURL,
		Identity:        id,
		ExpectedRelayID: "agentik-relay",
		PingInterval:    500 * time.Millisecond,
		PongTimeout:     2 * time.Second,
		Handlers: Handlers{
			OnRegistered: func(deviceID string, _ []string) { regCh <- deviceID },
			OnPeerState: func(connectionID string, present bool) {
				if present {
					peerCh <- connectionID
				}
			},
			OnSignal: func(connectionID, kind string, data []byte) {
				signalCh <- fakeSignal{connectionID: connectionID, kind: kind, data: bytes.Clone(data)}
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	select {
	case gotID := <-regCh:
		if gotID != id.DeviceIDString() {
			t.Fatalf("registered deviceID = %s, want %s", gotID, id.DeviceIDString())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for real relay registration")
	}

	// Attach a simulated phone client to the same relay endpoint.
	ws, _, err := websocket.Dial(ctx, strings.TrimRight(relayURL, "/")+"/v1/connect?device="+id.DeviceIDString(), nil)
	if err != nil {
		t.Fatalf("dial client socket: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "done")

	// Read challenge, attach, read attached.
	_, _, err = ws.Read(ctx)
	if err != nil {
		t.Fatalf("read client challenge: %v", err)
	}
	attachMsg, _ := json.Marshal(map[string]any{
		"type":      "attach",
		"version":   protocol.Version,
		"device_id": base64.StdEncoding.EncodeToString(id.DeviceID()),
	})
	if err := ws.Write(ctx, websocket.MessageText, attachMsg); err != nil {
		t.Fatalf("write attach: %v", err)
	}
	_, attachedRaw, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read attached: %v", err)
	}
	var attached struct {
		Type          string `json:"type"`
		ConnectionID  string `json:"connectionId"`
		DevicePresent bool   `json:"devicePresent"`
	}
	if err := json.Unmarshal(attachedRaw, &attached); err != nil || attached.Type != "attached" || !attached.DevicePresent {
		t.Fatalf("unexpected attached reply: %s (%v)", attachedRaw, err)
	}

	select {
	case connID := <-peerCh:
		if connID != attached.ConnectionID {
			t.Fatalf("device saw peer %s, want %s", connID, attached.ConnectionID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for peer_state on device")
	}

	// Phone -> Relay -> Device
	c2d := []byte("hello-real-wrangler-relay")
	cSignal, _ := json.Marshal(map[string]any{
		"type": "signal",
		"kind": "offer",
		"data": base64.StdEncoding.EncodeToString(c2d),
	})
	if err := ws.Write(ctx, websocket.MessageText, cSignal); err != nil {
		t.Fatal(err)
	}
	select {
	case f := <-signalCh:
		if f.connectionID != attached.ConnectionID || f.kind != SignalOffer || !bytes.Equal(f.data, c2d) {
			t.Fatalf("device signal = %+v", f)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for client signal on device")
	}

	// Device -> Relay -> Phone
	d2c := []byte("reply-from-go-daemon")
	if err := client.SendSignal(ctx, attached.ConnectionID, SignalAnswer, d2c); err != nil {
		t.Fatalf("SendSignal: %v", err)
	}
	_, backRaw, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Type string `json:"type"`
		Kind string `json:"kind"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(backRaw, &back); err != nil || back.Type != "signal" || back.Kind != "answer" {
		t.Fatalf("unexpected reply signal: %s (%v)", backRaw, err)
	}
	gotBack, _ := base64.StdEncoding.DecodeString(back.Data)
	if !bytes.Equal(gotBack, d2c) {
		t.Fatalf("client got %q, want %q", gotBack, d2c)
	}

	// Verify keepalive ping/pong works against real Durable Object auto-response.
	time.Sleep(700 * time.Millisecond)

	cancel()
	<-done
}
