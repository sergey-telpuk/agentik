package secure

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	mrand "math/rand/v2"
	"sync"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// Concurrent Sends on one session must reach the wire in nonce order, or the
// peer fails to decrypt everything after the first reordered frame.
func TestManagedSessionConcurrentSendsKeepNonceOrder(t *testing.T) {
	daemonKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	phoneKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	deviceID := make([]byte, protocol.DeviceIDSize)

	var mu sync.Mutex
	var frames [][]byte
	ready := make(chan *ManagedSession, 1)
	sender := senderFunc(func(_ context.Context, _ string, data []byte) error {
		time.Sleep(time.Duration(mrand.IntN(100)) * time.Microsecond)
		mu.Lock()
		frames = append(frames, append([]byte(nil), data...))
		mu.Unlock()
		return nil
	})
	mgr, err := NewManager(ManagerConfig{
		DeviceID:       deviceID,
		StaticKey:      daemonKey,
		Sender:         sender,
		VerifyPeer:     func(context.Context, string, []byte) error { return nil },
		OnSessionReady: func(_ context.Context, s *ManagedSession) { ready <- s },
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	const connID = "conn-order"
	mgr.HandlePeerState(ctx, connID, true)
	hs, err := NewHandshake(Config{
		Initiator:  true,
		StaticKey:  phoneKey,
		Prologue:   DevicePrologue(deviceID),
		VerifyPeer: func([]byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	msg1, err := hs.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	mgr.HandleFrame(ctx, connID, msg1)
	mu.Lock()
	if len(frames) != 1 {
		mu.Unlock()
		t.Fatalf("expected handshake reply, got %d frames", len(frames))
	}
	msg2 := frames[0]
	frames = nil
	mu.Unlock()
	if _, err := hs.ReadMessage(msg2); err != nil {
		t.Fatal(err)
	}
	msg3, err := hs.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	mgr.HandleFrame(ctx, connID, msg3)
	sess := <-ready
	phone, err := hs.Session()
	if err != nil {
		t.Fatal(err)
	}

	const senders, perSender = 8, 40
	var wg sync.WaitGroup
	for range senders {
		wg.Go(func() {
			for range perSender {
				if err := sess.Send(ctx, []byte("payload")); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Wait()

	if len(frames) != senders*perSender {
		t.Fatalf("got %d frames", len(frames))
	}
	for i, f := range frames {
		if _, err := phone.Decrypt(f); err != nil {
			t.Fatalf("frame %d does not decrypt in wire order: %v", i, errors.Unwrap(err))
		}
	}
}
