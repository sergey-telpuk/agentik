package webrtc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
)

// allowedKinds are the only things the relay may ever carry.
var allowedKinds = map[string]bool{KindOffer: true, KindAnswer: true, KindICE: true, KindICEServers: true}

func assertSignalingOnly(t *testing.T, relay *testRelay, forbidden ...string) {
	t.Helper()
	for _, r := range relay.records() {
		if !allowedKinds[r.kind] {
			t.Fatalf("the relay carried a %q message", r.kind)
		}
		for _, f := range forbidden {
			if bytes.Contains(r.data, []byte(f)) {
				t.Fatalf("the relay carried application content %q in a %s signal", f, r.kind)
			}
		}
	}
}

func TestLoopbackNoiseAndRPCOverDataChannel(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	phoneKey := newPhoneKey(t)

	phone := startPhone(t, d)
	if err := phone.waitOpen(10 * time.Second); err != nil {
		t.Fatalf("%v\n%s", err, d.events)
	}
	waitFor(t, "daemon data channel", 5*time.Second, func() bool { return d.acc.Connected(testConnID) })

	sess, err := runNoise(phone, phoneKey, d.id.NoisePublicKey(), bindingFor(t, d, phone))
	if err != nil {
		t.Fatalf("noise over the data channel: %v", err)
	}
	resp := rpc(t, phone, sess, "device.info")
	if !resp.OK {
		t.Fatalf("device.info failed: %+v", resp.Error)
	}
	raw, _ := json.Marshal(resp.Result)
	if !strings.Contains(string(raw), `"pairing_state":"unpaired"`) {
		t.Fatalf("unexpected device.info result: %s", raw)
	}

	// The relay carried signaling and nothing else: neither the method name
	// nor the response ever crossed it, and no message kind outside the set.
	assertSignalingOnly(t, relay, "device.info", "pairing_state")
	kinds := map[string]bool{}
	for _, r := range relay.records() {
		kinds[r.kind] = true
	}
	for _, k := range []string{KindICEServers, KindOffer, KindAnswer, KindICE} {
		if !kinds[k] {
			t.Errorf("expected a %q signal in the exchange", k)
		}
	}
}

func TestOpenDataChannelSurvivesRelayDeparture(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	phoneKey := newPhoneKey(t)
	phone := startPhone(t, d)
	if err := phone.waitOpen(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "daemon data channel", 5*time.Second, func() bool { return d.acc.Connected(testConnID) })
	sess, err := runNoise(phone, phoneKey, d.id.NoisePublicKey(), bindingFor(t, d, phone))
	if err != nil {
		t.Fatal(err)
	}

	// The phone closes its relay socket and the daemon's relay drops and
	// re-registers: the DataChannel does not depend on either.
	d.acc.HandlePeerState(d.ctx, testConnID, false)
	d.acc.HandleRegistered(d.ctx, nil)
	if !d.acc.Connected(testConnID) {
		t.Fatal("the connection was closed when the relay forgot the client")
	}
	if resp := rpc(t, phone, sess, "device.info"); !resp.OK {
		t.Fatalf("RPC after relay departure failed: %+v", resp.Error)
	}
}

// TestSwappedFingerprintMakesHandshakeFail puts a real man in the middle on
// signaling and on the DataChannel. The attacker terminates DTLS toward both
// sides with its own certificates and copies Noise frames between them. DTLS
// succeeds on both legs, since each leg's fingerprint was swapped consistently,
// and only the fingerprint binding in the Noise prologue stops it.
func TestSwappedFingerprintMakesHandshakeFail(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	phoneKey := newPhoneKey(t)

	var (
		mu       sync.Mutex
		mitmFace *rtcAnswerer // faces the phone
		mitmBack *rtcOfferer  // faces the daemon
		forwards int
	)
	api := newTestAPI()

	// Phone -> relay: the attacker answers the phone itself and opens its own
	// offer toward the daemon.
	relay.mu.Lock()
	relay.toDaemon = func(kind string, data []byte) {
		mu.Lock()
		defer mu.Unlock()
		switch kind {
		case KindOffer:
			mitmFace = newAnswerer(t, api, func(k string, b []byte) { relay.mitmToPhone(k, b) })
			mitmBack = newOfferer(t, api, nil, func(k string, b []byte) { d.acc.HandleSignal(d.ctx, testConnID, k, b) })
			face, back := mitmFace, mitmBack
			face.dcHandler = func(m []byte) {
				mu.Lock()
				forwards++
				mu.Unlock()
				<-back.opened
				_ = back.dc.Send(m)
			}
			go func() {
				for m := range back.msgs {
					<-face.opened
					mu.Lock()
					forwards++
					mu.Unlock()
					_ = face.dc.Send(m)
				}
			}()
			face.onSignal(kind, data)
		default:
			if mitmFace != nil {
				mitmFace.onSignal(kind, data)
			}
		}
	}
	// Daemon -> relay: answers and candidates go to the attacker's offerer leg.
	var phone *rtcOfferer
	relay.toPhone = func(kind string, data []byte) {
		if kind == KindICEServers {
			return
		}
		mu.Lock()
		back := mitmBack
		mu.Unlock()
		if back != nil {
			back.onSignal(kind, data)
		}
	}
	relay.mu.Unlock()

	// The phone's own signaling reaches the daemon only through the attacker,
	// and what the attacker returns to the phone is the attacker's answer.
	relay.setMitmToPhone(func(kind string, data []byte) {
		mu.Lock()
		p := phone
		mu.Unlock()
		if p != nil {
			p.onSignal(kind, data)
		}
	})

	d.wirePeer()
	time.Sleep(50 * time.Millisecond) // ice_servers are irrelevant to the phone here
	mu.Lock()
	p := newOfferer(t, api, nil, relay.phoneSend)
	phone = p
	mu.Unlock()

	if err := phone.waitOpen(10 * time.Second); err != nil {
		t.Fatalf("the attacker's DTLS leg to the phone should open: %v", err)
	}
	waitFor(t, "daemon leg", 5*time.Second, func() bool { return d.acc.Connected(testConnID) })

	// The phone binds its own real fingerprint and the fingerprint it saw in
	// the (swapped) answer. The daemon binds the attacker's fingerprint as the
	// phone's. The two prologues differ.
	_, err := runNoise(phone, phoneKey, d.id.NoisePublicKey(), bindingFor(t, d, phone))
	if err == nil {
		t.Fatal("the Noise handshake completed through a signaling man in the middle")
	}
	if !strings.Contains(err.Error(), "handshake message") {
		t.Fatalf("expected a Noise failure, got %v", err)
	}
	mu.Lock()
	n := forwards
	mu.Unlock()
	if n < 2 {
		t.Fatalf("only %d frames crossed the attacker; the failure must come from Noise, not from a dead link", n)
	}
	if _, ok := d.hub.Manager().Session(testConnID); ok {
		t.Fatal("the daemon holds a session for the attacker's connection")
	}
}

func TestDataChannelThatNeverOpensSendsNothingThroughTheRelay(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 400*time.Millisecond)

	// Strip every candidate, in SDP and as trickle messages, so ICE has no
	// pair to check and the DataChannel can never open.
	strip := func(kind string, data []byte) ([]byte, bool) {
		if kind == KindICE {
			return nil, false
		}
		var m SDPMessage
		if json.Unmarshal(data, &m) == nil && m.SDP != "" {
			var kept []string
			for _, l := range strings.Split(m.SDP, "\n") {
				if !strings.HasPrefix(strings.TrimSpace(l), "a=candidate:") {
					kept = append(kept, l)
				}
			}
			m.SDP = strings.Join(kept, "\n")
			out, _ := json.Marshal(m)
			return out, true
		}
		return data, true
	}
	var phone *rtcOfferer
	var mu sync.Mutex
	relay.mu.Lock()
	relay.toDaemon = func(kind string, data []byte) {
		if out, ok := strip(kind, data); ok {
			d.acc.HandleSignal(d.ctx, testConnID, kind, out)
		}
	}
	relay.toPhone = func(kind string, data []byte) {
		if kind == KindICEServers {
			return
		}
		if out, ok := strip(kind, data); ok {
			mu.Lock()
			p := phone
			mu.Unlock()
			if p != nil {
				p.onSignal(kind, out)
			}
		}
	}
	relay.mu.Unlock()

	d.wirePeer()
	mu.Lock()
	p := newOfferer(t, newTestAPI(), nil, relay.phoneSend)
	phone = p
	mu.Unlock()

	waitFor(t, "the daemon to give up", 5*time.Second, func() bool { return d.events.has("did not open") })
	if d.acc.Connected(testConnID) {
		t.Fatal("a connection is reported open")
	}
	if err := d.acc.SendFrame(context.Background(), testConnID, []byte("application data")); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("SendFrame without a data channel: %v, want ErrNotOpen", err)
	}
	if _, ok := d.hub.Manager().Session(testConnID); ok {
		t.Fatal("a Noise session exists although the data channel never opened")
	}

	// The failed attempt put nothing but signaling on the relay, and the
	// daemon has no call that could put anything else there.
	assertSignalingOnly(t, relay, "application data")
	before := len(relay.records())
	_ = d.acc.SendFrame(context.Background(), testConnID, []byte("application data"))
	time.Sleep(100 * time.Millisecond)
	if after := len(relay.records()); after != before {
		t.Fatalf("SendFrame produced %d relay messages", after-before)
	}
}

func TestOfferWithoutFingerprintIsRefused(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	d.wirePeer()
	body, _ := json.Marshal(SDPMessage{V: SignalVersion, SDP: "v=0\r\ns=-\r\nt=0 0\r\n"})
	d.acc.HandleSignal(d.ctx, testConnID, KindOffer, body)
	waitFor(t, "refusal", 3*time.Second, func() bool { return d.events.has("offer rejected") })
	if _, err := d.acc.Prologue(testConnID); err == nil {
		t.Fatal("a prologue exists for a refused offer")
	}
}

func TestPrologueUnavailableBeforeOffer(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	d.wirePeer()
	if _, err := d.acc.Prologue(testConnID); err == nil {
		t.Fatal("a prologue exists before any offer")
	}
	if _, err := d.acc.Prologue("ffffffffffffffffffffffffffffffff"); err == nil {
		t.Fatal("a prologue exists for an unknown connection")
	}
}

func TestSignalsForUnknownConnectionAreDropped(t *testing.T) {
	relay := newTestRelay(t)
	d := newDaemonSide(t, relay, ICEConfig{}, 10*time.Second)
	body, _ := json.Marshal(SDPMessage{V: SignalVersion, SDP: "x"})
	d.acc.HandleSignal(d.ctx, testConnID, KindOffer, body)
	if !d.events.has("unknown connection") {
		t.Fatal("expected the signal to be dropped and logged")
	}
}

func TestICEServersSignalCarriesTimeLimitedCredentials(t *testing.T) {
	relay := newTestRelay(t)
	now := time.Unix(1_800_000_000, 0)
	cfg := ICEConfig{
		STUNURLs:   []string{"stun:turn.example.org:3478"},
		TURNURLs:   []string{"turn:turn.example.org:3478?transport=udp"},
		TURNSecret: []byte("shared-secret"),
		TURNTTL:    5 * time.Minute,
		Now:        func() time.Time { return now },
	}
	d := newDaemonSide(t, relay, cfg, 10*time.Second)
	got := make(chan ICEServersMessage, 1)
	relay.mu.Lock()
	relay.toPhone = func(kind string, data []byte) {
		var m ICEServersMessage
		if kind == KindICEServers && json.Unmarshal(data, &m) == nil {
			got <- m
		}
	}
	relay.mu.Unlock()
	d.wirePeer()

	select {
	case m := <-got:
		if len(m.Servers) != 2 {
			t.Fatalf("servers = %+v", m.Servers)
		}
		turn := m.Servers[1]
		if turn.Username != "1800000300:agentik" {
			t.Fatalf("username = %q, want the expiry five minutes ahead", turn.Username)
		}
		user, cred := cfg.TURNCredentials("agentik")
		if turn.Username != user || turn.Credential != cred {
			t.Fatalf("credential does not match the HMAC derivation")
		}
		if strings.Contains(string(mustJSON(m)), "shared-secret") {
			t.Fatal("the TURN secret leaked into the signal")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no ice_servers signal")
	}
}

func TestTURNCredentialsRationed(t *testing.T) {
	relay := newTestRelay(t)
	now := time.Unix(1_800_000_000, 0)
	cfg := ICEConfig{
		STUNURLs:   []string{"stun:turn.example.org:3478"},
		TURNURLs:   []string{"turn:turn.example.org:3478"},
		TURNSecret: []byte("s"),
		Now:        func() time.Time { return now },
	}
	d := newDaemonSide(t, relay, cfg, 10*time.Second)
	var mu sync.Mutex
	withCreds, withoutCreds := 0, 0
	relay.mu.Lock()
	relay.toPhone = func(kind string, data []byte) {
		var m ICEServersMessage
		if kind != KindICEServers || json.Unmarshal(data, &m) != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		for _, s := range m.Servers {
			if s.Username != "" {
				withCreds++
				return
			}
		}
		withoutCreds++
	}
	relay.mu.Unlock()
	for i := 0; i < maxICEServerIssuesPerMinute+5; i++ {
		id := fmt.Sprintf("%032x", i+1)
		d.acc.HandlePeerState(d.ctx, id, true)
		// Free the slot so MaxPeers does not interfere.
		d.acc.CloseConnection(id)
	}
	waitFor(t, "all signals", 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return withCreds+withoutCreds == maxICEServerIssuesPerMinute+5
	})
	mu.Lock()
	defer mu.Unlock()
	if withCreds != maxICEServerIssuesPerMinute || withoutCreds != 5 {
		t.Fatalf("with credentials %d, without %d", withCreds, withoutCreds)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestTransportHasNoApplicationDataPath(t *testing.T) {
	// The daemon's relay client refuses every kind but signaling, and the
	// acceptor's signaler interface cannot express anything else.
	var _ Signaler = (*transport.Client)(nil)
	for _, kind := range []string{"frame", "data", "rpc", "noise", "offer", ""} {
		for _, allowed := range transport.DeviceSignalKinds {
			if kind == allowed {
				t.Fatalf("%q must not be a device signal kind", kind)
			}
		}
	}
	_ = pion.SDPTypeOffer
}
