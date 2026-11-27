package secure

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// memNet stands in for the DataChannel: frames the Manager sends toward a
// connection are queued for the test phone of that connection, and the test
// phone's frames are handed straight to Manager.HandleFrame.
type memNet struct {
	mu      sync.Mutex
	inbox   map[string]chan []byte
	onWire  [][]byte // every ciphertext the Manager sent
	connSeq int
}

func newMemNet() *memNet { return &memNet{inbox: make(map[string]chan []byte)} }

func (n *memNet) SendFrame(_ context.Context, connID string, data []byte) error {
	n.mu.Lock()
	ch := n.inbox[connID]
	n.onWire = append(n.onWire, bytes.Clone(data))
	n.mu.Unlock()
	if ch == nil {
		return errors.New("no such connection")
	}
	ch <- bytes.Clone(data)
	return nil
}

func (n *memNet) newConn() (string, chan []byte) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.connSeq++
	id := fmt.Sprintf("conn-%d", n.connSeq)
	ch := make(chan []byte, 16)
	n.inbox[id] = ch
	return id, ch
}

type daemonStack struct {
	mgr     *Manager
	net     *memNet
	devID   *identity.Identity
	readyCh chan *ManagedSession
	msgCh   chan []byte
	errCh   chan error
	// prologue is what the daemon side will use for every connection.
	prologue []byte
}

func startDaemonStack(t *testing.T, trustedKey []byte, prologue []byte) *daemonStack {
	t.Helper()
	devID, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	s := &daemonStack{
		net:      newMemNet(),
		devID:    devID,
		readyCh:  make(chan *ManagedSession, 4),
		msgCh:    make(chan []byte, 8),
		errCh:    make(chan error, 8),
		prologue: prologue,
	}
	if s.prologue == nil {
		s.prologue = DevicePrologue(devID.DeviceID())
	}
	s.mgr, err = NewManager(ManagerConfig{
		DeviceID:  devID.DeviceID(),
		StaticKey: devID.NoisePrivateKey(),
		Sender:    s.net,
		Prologue:  func(string) ([]byte, error) { return s.prologue, nil },
		VerifyPeer: func(_ context.Context, _ string, clientStatic []byte) error {
			if !protocol.ConstantTimeEqual(clientStatic, trustedKey) {
				return errors.New("client static key not pinned")
			}
			return nil
		},
		OnSessionReady: func(_ context.Context, sess *ManagedSession) { s.readyCh <- sess },
		OnMessage:      func(_ context.Context, _ *ManagedSession, pt []byte) { s.msgCh <- bytes.Clone(pt) },
		OnError:        func(_ string, err error) { s.errCh <- err },
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(s.mgr.HandleDisconnected)
	return s
}

type testPhone struct {
	stack   *daemonStack
	connID  string
	inbox   chan []byte
	session *Session
}

// connectTestPhone runs the initiator side of the handshake against the
// Manager. It returns the error the phone saw, which is ErrPeerRejected when
// the phone's pin check fails, and a Noise error when the daemon rejected the
// handshake (the daemon's reply never arrives, so the phone times out).
func connectTestPhone(
	t *testing.T,
	s *daemonStack,
	phoneKey *ecdh.PrivateKey,
	pinnedDevicePub []byte,
	prologue []byte,
) (*testPhone, error) {
	t.Helper()
	ctx := context.Background()
	connID, inbox := s.net.newConn()
	s.mgr.HandlePeerState(ctx, connID, true)
	if prologue == nil {
		prologue = s.prologue
	}

	hs, err := NewHandshake(Config{
		Initiator: true,
		StaticKey: phoneKey,
		Prologue:  prologue,
		VerifyPeer: func(peerStatic []byte) error {
			if !protocol.ConstantTimeEqual(peerStatic, pinnedDevicePub) {
				return errors.New("device pin mismatch")
			}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}
	msg1, err := hs.WriteMessage(nil)
	if err != nil {
		return nil, err
	}
	s.mgr.HandleFrame(ctx, connID, msg1)

	var msg2 []byte
	select {
	case msg2 = <-inbox:
	case <-time.After(300 * time.Millisecond):
		return nil, errors.New("no handshake reply from the daemon")
	}
	if _, err := hs.ReadMessage(msg2); err != nil {
		return nil, err
	}
	msg3, err := hs.WriteMessage(nil)
	if err != nil {
		return nil, err
	}
	s.mgr.HandleFrame(ctx, connID, msg3)
	sess, err := hs.Session()
	if err != nil {
		return nil, err
	}
	return &testPhone{stack: s, connID: connID, inbox: inbox, session: sess}, nil
}

func (p *testPhone) sendEncrypted(plaintext []byte) ([]byte, error) {
	ct, err := p.session.Encrypt(plaintext)
	if err != nil {
		return nil, err
	}
	p.stack.mgr.HandleFrame(context.Background(), p.connID, ct)
	return ct, nil
}

func (p *testPhone) recvDecrypted() ([]byte, error) {
	select {
	case ct := <-p.inbox:
		return p.session.Decrypt(ct)
	case <-time.After(time.Second):
		return nil, errors.New("timed out")
	}
}

func fingerprint(b byte) []byte { return bytes.Repeat([]byte{b}, protocol.DTLSFingerprintSize) }

func TestNoiseOverDataChannel_HandshakeSuccessAndCiphertextOpacity(t *testing.T) {
	phoneKey := newStatic(t)
	s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), nil)

	phone, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatalf("connectTestPhone: %v", err)
	}
	var daemonSess *ManagedSession
	select {
	case daemonSess = <-s.readyCh:
	case err := <-s.errCh:
		t.Fatalf("unexpected daemon noise error: %v", err)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for daemon session")
	}

	secretPrompt := []byte(`{"v":1,"request_id":"r1","method":"task.start","params":{"prompt":"super secret prompt"}}`)
	if _, err := phone.sendEncrypted(secretPrompt); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-s.msgCh:
		if !bytes.Equal(got, secretPrompt) {
			t.Fatalf("daemon decrypted = %q, want %q", got, secretPrompt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for decrypted message")
	}

	reply := []byte(`{"v":1,"request_id":"r1","ok":true}`)
	if err := daemonSess.Send(context.Background(), reply); err != nil {
		t.Fatal(err)
	}
	gotReply, err := phone.recvDecrypted()
	if err != nil || !bytes.Equal(gotReply, reply) {
		t.Fatalf("phone decrypted = %q, %v", gotReply, err)
	}

	s.net.mu.Lock()
	defer s.net.mu.Unlock()
	for _, raw := range s.net.onWire {
		if bytes.Contains(raw, []byte("super secret prompt")) || bytes.Contains(raw, []byte(`"ok":true`)) {
			t.Fatal("the wire carried a plaintext payload")
		}
	}
}

func TestNoiseOverDataChannel_WrongPinRejected(t *testing.T) {
	trustedPhone := newStatic(t)
	attackerPhone := newStatic(t)
	s := startDaemonStack(t, trustedPhone.PublicKey().Bytes(), nil)

	// 1. Unknown/unpinned phone: the responder rejects at message 3.
	attacker, err := connectTestPhone(t, s, attackerPhone, s.devID.NoisePublicKey(), nil)
	if err == nil {
		_, _ = attacker.sendEncrypted([]byte("unauthorized command"))
	}
	select {
	case err := <-s.errCh:
		if !errors.Is(err, ErrPeerRejected) {
			t.Fatalf("expected ErrPeerRejected, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ErrPeerRejected")
	}
	select {
	case <-s.readyCh:
		t.Fatal("untrusted client created a session")
	case <-s.msgCh:
		t.Fatal("untrusted client delivered a message")
	case <-time.After(80 * time.Millisecond):
	}

	// 2. Trusted phone with the wrong pinned device key aborts at message 2.
	wrongDeviceKey := newStatic(t).PublicKey().Bytes()
	if _, err := connectTestPhone(t, s, trustedPhone, wrongDeviceKey, nil); !errors.Is(err, ErrPeerRejected) {
		t.Fatalf("wrong device pin: got %v, want ErrPeerRejected", err)
	}
}

func TestNoiseOverDataChannel_ReplayRejected(t *testing.T) {
	phoneKey := newStatic(t)
	s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), nil)
	phone, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-s.readyCh

	first := []byte("first-and-only")
	captured, err := phone.sendEncrypted(first)
	if err != nil {
		t.Fatal(err)
	}
	if got := <-s.msgCh; !bytes.Equal(got, first) {
		t.Fatalf("got %q, want %q", got, first)
	}

	s.mgr.HandleFrame(context.Background(), phone.connID, captured)
	select {
	case err := <-s.errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("unexpected error on replay: %v", err)
		}
	case got := <-s.msgCh:
		t.Fatalf("replayed ciphertext was decrypted: %q", got)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replay rejection")
	}
}

func TestNoiseOverDataChannel_CrossSessionIncompatibility(t *testing.T) {
	phoneKey := newStatic(t)
	s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), nil)

	phone1, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-s.readyCh
	oldCT, err := phone1.session.Encrypt([]byte("old-session-command"))
	if err != nil {
		t.Fatal(err)
	}
	s.mgr.CloseConnection(phone1.connID)

	phone2, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-s.readyCh

	s.mgr.HandleFrame(context.Background(), phone2.connID, oldCT)
	select {
	case err := <-s.errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("expected decrypt error on cross-session frame, got %v", err)
		}
	case got := <-s.msgCh:
		t.Fatalf("cross-session ciphertext accepted: %q", got)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cross-session rejection")
	}
}

func TestNoiseOverDataChannel_PerConnectionIsolation(t *testing.T) {
	phoneKey := newStatic(t)
	s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), nil)

	phoneA, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-s.readyCh
	phoneB, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-s.readyCh

	ctFromA, err := phoneA.session.Encrypt([]byte("for-connection-A-only"))
	if err != nil {
		t.Fatal(err)
	}
	s.mgr.HandleFrame(context.Background(), phoneB.connID, ctFromA)
	select {
	case err := <-s.errCh:
		if !strings.Contains(err.Error(), "decrypt") {
			t.Fatalf("expected decrypt error across connections, got %v", err)
		}
	case got := <-s.msgCh:
		t.Fatalf("frame encrypted on conn A decrypted on conn B: %q", got)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cross-connection rejection")
	}
}

func TestNoiseOverDataChannel_FingerprintBinding(t *testing.T) {
	phoneKey := newStatic(t)
	dev, _ := identity.Generate()
	deviceID := dev.DeviceID()

	daemonView, err := WebRTCPrologue(deviceID, fingerprint(0xA1), fingerprint(0xB2))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("matching fingerprints complete", func(t *testing.T) {
		s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), daemonView)
		if _, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), daemonView); err != nil {
			t.Fatalf("handshake with equal prologues: %v", err)
		}
	})

	cases := map[string][2][]byte{
		"phone fingerprint swapped":  {fingerprint(0xEE), fingerprint(0xB2)},
		"daemon fingerprint swapped": {fingerprint(0xA1), fingerprint(0xEE)},
		"both swapped":               {fingerprint(0xEE), fingerprint(0xEF)},
		"roles reversed":             {fingerprint(0xB2), fingerprint(0xA1)},
	}
	for name, fps := range cases {
		t.Run(name, func(t *testing.T) {
			phoneView, err := WebRTCPrologue(deviceID, fps[0], fps[1])
			if err != nil {
				t.Fatal(err)
			}
			s := startDaemonStack(t, phoneKey.PublicKey().Bytes(), daemonView)
			if _, err := connectTestPhone(t, s, phoneKey, s.devID.NoisePublicKey(), phoneView); err == nil {
				t.Fatal("handshake completed although the peers saw different fingerprints")
			}
			select {
			case <-s.readyCh:
				t.Fatal("the daemon created a session")
			case <-time.After(50 * time.Millisecond):
			}
		})
	}
}

func TestWebRTCPrologueValidation(t *testing.T) {
	id := bytes.Repeat([]byte{7}, protocol.DeviceIDSize)
	if _, err := WebRTCPrologue(id, fingerprint(1)[:31], fingerprint(2)); err == nil {
		t.Fatal("a short fingerprint was accepted")
	}
	if _, err := WebRTCPrologue(id, fingerprint(1), append(fingerprint(2), 0)); err == nil {
		t.Fatal("a long fingerprint was accepted")
	}
	a, _ := WebRTCPrologue(id, fingerprint(1), fingerprint(2))
	b, _ := WebRTCPrologue(id, fingerprint(2), fingerprint(1))
	if bytes.Equal(a, b) {
		t.Fatal("swapping the two fingerprints must change the prologue")
	}
	if bytes.Equal(a, DevicePrologue(id)) {
		t.Fatal("the bound prologue must differ from the base prologue")
	}
}

func TestManagerRequiresPrologueAndAbortsWithoutOne(t *testing.T) {
	dev, _ := identity.Generate()
	base := ManagerConfig{
		DeviceID:   dev.DeviceID(),
		StaticKey:  dev.NoisePrivateKey(),
		Sender:     newMemNet(),
		VerifyPeer: func(context.Context, string, []byte) error { return nil },
	}
	if _, err := NewManager(base); err == nil {
		t.Fatal("a Manager without a Prologue was accepted")
	}

	errCh := make(chan error, 1)
	base.Prologue = func(string) ([]byte, error) { return nil, errors.New("no fingerprints for this connection") }
	base.OnError = func(_ string, err error) { errCh <- err }
	mgr, err := NewManager(base)
	if err != nil {
		t.Fatal(err)
	}
	mgr.HandlePeerState(context.Background(), "c1", true)
	select {
	case err := <-errCh:
		if !strings.Contains(err.Error(), "no fingerprints") {
			t.Fatalf("unexpected error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("no error reported")
	}
	if _, ok := mgr.Session("c1"); ok {
		t.Fatal("a session exists for a connection with no prologue")
	}
}
