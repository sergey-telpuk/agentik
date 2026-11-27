package webrtc

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/projects"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

const testConnID = "0123456789abcdef0123456789abcdef"

// newTestAPI returns a pion API that connects over loopback only, so tests
// need no network and finish quickly.
func newTestAPI() *pion.API {
	se := pion.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]pion.NetworkType{pion.NetworkTypeUDP4})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetInterfaceFilter(func(name string) bool { return strings.HasPrefix(name, "lo") })
	return pion.NewAPI(pion.WithSettingEngine(se))
}

// signalRecord is one payload the fake relay carried.
type signalRecord struct {
	toDaemon bool
	kind     string
	data     []byte
}

// testRelay is an in-memory stand-in for the signaling relay. It delivers
// payloads in order, records every one, and lets a test rewrite or drop them
// in transit. It has no way to carry anything but signals.
type testRelay struct {
	mu  sync.Mutex
	log []signalRecord

	// Delivery targets; a test may replace them to intercept traffic.
	toDaemon func(kind string, data []byte)
	toPhone  func(kind string, data []byte)
	// mitmPhone is where an interposed attacker's messages reach the phone.
	mitmPhone func(kind string, data []byte)

	qDaemon chan func()
	qPhone  chan func()
	done    chan struct{}
}

func newTestRelay(t *testing.T) *testRelay {
	r := &testRelay{qDaemon: make(chan func(), 512), qPhone: make(chan func(), 512), done: make(chan struct{})}
	for _, q := range []chan func(){r.qDaemon, r.qPhone} {
		go func(q chan func()) {
			for {
				select {
				case f := <-q:
					f()
				case <-r.done:
					return
				}
			}
		}(q)
	}
	noop := func(string, []byte) {}
	r.toDaemon, r.toPhone, r.mitmPhone = noop, noop, noop
	t.Cleanup(func() { close(r.done) })
	return r
}

func (r *testRelay) record(toDaemon bool, kind string, data []byte) {
	r.mu.Lock()
	r.log = append(r.log, signalRecord{toDaemon: toDaemon, kind: kind, data: bytes.Clone(data)})
	r.mu.Unlock()
}

func (r *testRelay) records() []signalRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]signalRecord(nil), r.log...)
}

// phoneSend is what the phone's relay socket does.
func (r *testRelay) phoneSend(kind string, data []byte) {
	r.record(true, kind, data)
	data = bytes.Clone(data)
	r.qDaemon <- func() {
		r.mu.Lock()
		f := r.toDaemon
		r.mu.Unlock()
		f(kind, data)
	}
}

// SendSignal is the daemon's Signaler.
func (r *testRelay) SendSignal(_ context.Context, connectionID, kind string, data []byte) error {
	if len(connectionID) != 32 {
		return errors.New("bad connection id")
	}
	r.record(false, kind, data)
	data = bytes.Clone(data)
	r.qPhone <- func() {
		r.mu.Lock()
		f := r.toPhone
		r.mu.Unlock()
		f(kind, data)
	}
	return nil
}

// daemonSide is a real acceptor wired to a real runtime hub.
type daemonSide struct {
	acc      *Acceptor
	hub      *runtime.Hub
	id       *identity.Identity
	relay    *testRelay
	events   *eventLog
	secErrs  chan error
	pairSvc  *pairing.Service
	ctx      context.Context
	cancel   context.CancelFunc
	wirePeer func() // attach the phone to the acceptor (the relay's peer_state)
}

type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (e *eventLog) add(s string) {
	e.mu.Lock()
	e.events = append(e.events, s)
	e.mu.Unlock()
}

func (e *eventLog) has(substr string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.events {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}

func (e *eventLog) String() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.Join(e.events, "\n")
}

func waitFor(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func newDaemonSide(t *testing.T, relay *testRelay, ice ICEConfig, connectTimeout time.Duration) *daemonSide {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	db, err := storage.Open(ctx, storage.InMemory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	pairSvc, err := pairing.NewService(pairing.Config{DB: db, Identity: id})
	if err != nil {
		t.Fatal(err)
	}
	cat, err := projects.NewCatalogue(nil)
	if err != nil {
		t.Fatal(err)
	}

	d := &daemonSide{id: id, relay: relay, events: &eventLog{}, secErrs: make(chan error, 16), pairSvc: pairSvc, ctx: ctx, cancel: cancel}
	acc, err := NewAcceptor(Config{
		DeviceID:       id.DeviceID(),
		Signaler:       relay,
		ICE:            ice,
		ConnectTimeout: connectTimeout,
		API:            newTestAPI(),
		OnEvent:        func(connID, ev string) { d.events.add(connID + ": " + ev) },
	})
	if err != nil {
		t.Fatal(err)
	}
	hub, err := runtime.NewHub(id, pairSvc, runtime.Config{
		DB:       db,
		Identity: id,
		Pairing:  pairSvc,
		Projects: cat,
		Agents:   map[string]codex.Adapter{},
	}, acc, acc.Prologue, func(_ string, err error) { d.secErrs <- err })
	if err != nil {
		t.Fatal(err)
	}
	acc.SetSessions(hub.Manager())
	hub.SetOnSessionClosed(acc.CloseConnection)
	t.Cleanup(func() { acc.Close(); hub.Close() })
	d.acc, d.hub = acc, hub

	relay.mu.Lock()
	relay.toDaemon = func(kind string, data []byte) { acc.HandleSignal(ctx, testConnID, kind, data) }
	relay.mu.Unlock()
	d.wirePeer = func() { acc.HandlePeerState(ctx, testConnID, true) }

	// An unknown phone may finish a Noise handshake only while an invitation
	// is active, so that it can submit pair.submit.
	if _, err := pairSvc.CreateInvitation(ctx, "wss://relay.example.com", time.Minute); err != nil {
		t.Fatal(err)
	}
	return d
}

// ---- phone side ----

// rtcOfferer is the phone's role: it creates the DataChannel and the offer.
type rtcOfferer struct {
	t       *testing.T
	pc      *pion.PeerConnection
	dc      *pion.DataChannel
	send    func(kind string, data []byte)
	msgs    chan []byte
	opened  chan struct{}
	localFP []byte

	mu       sync.Mutex
	remoteFP []byte
	remoteOK bool
	pending  []pion.ICECandidateInit
}

func newOfferer(t *testing.T, api *pion.API, servers []pion.ICEServer, send func(kind string, data []byte)) *rtcOfferer {
	t.Helper()
	pc, err := api.NewPeerConnection(pion.Configuration{ICEServers: servers})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	o := &rtcOfferer{t: t, pc: pc, send: send, msgs: make(chan []byte, 64), opened: make(chan struct{})}
	dc, err := pc.CreateDataChannel(DataChannelLabel, nil)
	if err != nil {
		t.Fatal(err)
	}
	o.dc = dc
	dc.OnOpen(func() { close(o.opened) })
	dc.OnMessage(func(m pion.DataChannelMessage) { o.msgs <- bytes.Clone(m.Data) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	o.localFP, err = ExtractFingerprint(offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	// Candidates start once the local description is set; the offer goes out
	// first, so the daemon has the offer before any candidate.
	pc.OnICECandidate(func(c *pion.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		b, _ := json.Marshal(ICEMessage{V: SignalVersion, Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex, UsernameFragment: init.UsernameFragment})
		send(KindICE, b)
	})
	b, _ := json.Marshal(SDPMessage{V: SignalVersion, SDP: offer.SDP})
	send(KindOffer, b)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	return o
}

// onSignal handles an answer or ICE candidate from the daemon side.
func (o *rtcOfferer) onSignal(kind string, data []byte) {
	switch kind {
	case KindAnswer:
		var m SDPMessage
		if err := json.Unmarshal(data, &m); err != nil {
			o.t.Errorf("bad answer: %v", err)
			return
		}
		fp, err := ExtractFingerprint(m.SDP)
		if err != nil {
			o.t.Errorf("answer fingerprint: %v", err)
			return
		}
		if err := o.pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: m.SDP}); err != nil {
			o.t.Errorf("set remote description: %v", err)
			return
		}
		o.mu.Lock()
		o.remoteFP, o.remoteOK = fp, true
		pending := o.pending
		o.pending = nil
		o.mu.Unlock()
		for _, c := range pending {
			_ = o.pc.AddICECandidate(c)
		}
	case KindICE:
		var m ICEMessage
		if err := json.Unmarshal(data, &m); err != nil || m.Candidate == "" {
			return
		}
		init := pion.ICECandidateInit{Candidate: m.Candidate, SDPMid: m.SDPMid, SDPMLineIndex: m.SDPMLineIndex, UsernameFragment: m.UsernameFragment}
		o.mu.Lock()
		if !o.remoteOK {
			o.pending = append(o.pending, init)
			o.mu.Unlock()
			return
		}
		o.mu.Unlock()
		_ = o.pc.AddICECandidate(init)
	}
}

func (o *rtcOfferer) remoteFingerprint() []byte {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.remoteFP
}

func (o *rtcOfferer) waitOpen(d time.Duration) error {
	select {
	case <-o.opened:
		return nil
	case <-time.After(d):
		return errors.New("data channel did not open")
	}
}

// startPhone attaches a phone to the daemon side through the relay and opens
// its DataChannel offer. It returns once the offer is sent.
func startPhone(t *testing.T, d *daemonSide) *rtcOfferer {
	t.Helper()
	servers := make(chan ICEServersMessage, 1)
	var offerer *rtcOfferer
	var mu sync.Mutex
	d.relay.mu.Lock()
	d.relay.toPhone = func(kind string, data []byte) {
		if kind == KindICEServers {
			var m ICEServersMessage
			if err := json.Unmarshal(data, &m); err == nil {
				servers <- m
			}
			return
		}
		mu.Lock()
		o := offerer
		mu.Unlock()
		if o != nil {
			o.onSignal(kind, data)
		}
	}
	d.relay.mu.Unlock()

	d.wirePeer()
	var msg ICEServersMessage
	select {
	case msg = <-servers:
	case <-time.After(3 * time.Second):
		t.Fatal("the daemon did not send ice_servers")
	}
	var ps []pion.ICEServer
	for _, s := range msg.Servers {
		ps = append(ps, pion.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	// Hold the lock across creation so an early answer waits for the
	// assignment instead of being dropped.
	mu.Lock()
	o := newOfferer(t, newTestAPI(), ps, d.relay.phoneSend)
	offerer = o
	mu.Unlock()
	return o
}

// runNoise runs the initiator side of Noise XX over the DataChannel.
func runNoise(o *rtcOfferer, phoneKey *ecdh.PrivateKey, pinned, prologue []byte) (*secure.Session, error) {
	hs, err := secure.NewHandshake(secure.Config{
		Initiator: true,
		StaticKey: phoneKey,
		Prologue:  prologue,
		VerifyPeer: func(peer []byte) error {
			if !bytes.Equal(peer, pinned) {
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
	if err := o.dc.Send(msg1); err != nil {
		return nil, err
	}
	var msg2 []byte
	select {
	case msg2 = <-o.msgs:
	case <-time.After(3 * time.Second):
		return nil, errors.New("no handshake reply")
	}
	if _, err := hs.ReadMessage(msg2); err != nil {
		return nil, err
	}
	msg3, err := hs.WriteMessage(nil)
	if err != nil {
		return nil, err
	}
	if err := o.dc.Send(msg3); err != nil {
		return nil, err
	}
	return hs.Session()
}

// rpc sends one request over the secure session and returns the response.
func rpc(t *testing.T, o *rtcOfferer, sess *secure.Session, method string) runtime.OutboundResponse {
	t.Helper()
	req, _ := json.Marshal(runtime.InboundRequest{V: 1, RequestID: "req-1", Method: method, Params: json.RawMessage(`{}`)})
	ct, err := sess.Encrypt(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := o.dc.Send(ct); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case frame := <-o.msgs:
			pt, err := sess.Decrypt(frame)
			if err != nil {
				t.Fatalf("decrypt: %v", err)
			}
			var resp runtime.OutboundResponse
			if json.Unmarshal(pt, &resp) == nil && resp.RequestID == "req-1" {
				return resp
			}
		case <-deadline:
			t.Fatal("no RPC response")
		}
	}
}

func newPhoneKey(t *testing.T) *ecdh.PrivateKey {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// bindingFor derives the prologue a phone computes from its own offer's
// fingerprint and the answer's fingerprint it received.
func bindingFor(t *testing.T, d *daemonSide, o *rtcOfferer) []byte {
	t.Helper()
	p, err := secure.WebRTCPrologue(d.id.DeviceID(), o.localFP, o.remoteFingerprint())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

var _ = fmt.Sprintf

// mitmToPhone delivers a message from the attacker to the phone.
func (r *testRelay) mitmToPhone(kind string, data []byte) {
	r.record(false, kind, data)
	data = bytes.Clone(data)
	r.qPhone <- func() {
		r.mu.Lock()
		f := r.mitmPhone
		r.mu.Unlock()
		f(kind, data)
	}
}

func (r *testRelay) setMitmToPhone(f func(kind string, data []byte)) {
	r.mu.Lock()
	r.mitmPhone = f
	r.mu.Unlock()
}

// rtcAnswerer is the daemon's role as seen by a test: it answers an offer.
type rtcAnswerer struct {
	t         *testing.T
	pc        *pion.PeerConnection
	dc        *pion.DataChannel
	send      func(kind string, data []byte)
	opened    chan struct{}
	dcHandler func([]byte)
	offered   bool
	gate      sync.Mutex
	answered  bool
	held      [][]byte
}

func newAnswerer(t *testing.T, api *pion.API, send func(kind string, data []byte)) *rtcAnswerer {
	t.Helper()
	pc, err := api.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	a := &rtcAnswerer{t: t, pc: pc, send: send, opened: make(chan struct{})}
	pc.OnICECandidate(func(c *pion.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		b, _ := json.Marshal(ICEMessage{V: SignalVersion, Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex, UsernameFragment: init.UsernameFragment})
		a.gate.Lock()
		if !a.answered {
			a.held = append(a.held, b)
			a.gate.Unlock()
			return
		}
		a.gate.Unlock()
		send(KindICE, b)
	})
	pc.OnDataChannel(func(dc *pion.DataChannel) {
		a.dc = dc
		dc.OnOpen(func() { close(a.opened) })
		dc.OnMessage(func(m pion.DataChannelMessage) {
			if a.dcHandler != nil {
				a.dcHandler(bytes.Clone(m.Data))
			}
		})
	})
	return a
}

func (a *rtcAnswerer) onSignal(kind string, data []byte) {
	switch kind {
	case KindOffer:
		var m SDPMessage
		if err := json.Unmarshal(data, &m); err != nil {
			a.t.Errorf("bad offer: %v", err)
			return
		}
		if err := a.pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeOffer, SDP: m.SDP}); err != nil {
			a.t.Errorf("set remote: %v", err)
			return
		}
		ans, err := a.pc.CreateAnswer(nil)
		if err != nil {
			a.t.Errorf("answer: %v", err)
			return
		}
		if err := a.pc.SetLocalDescription(ans); err != nil {
			a.t.Errorf("set local: %v", err)
			return
		}
		b, _ := json.Marshal(SDPMessage{V: SignalVersion, SDP: a.pc.LocalDescription().SDP})
		a.send(KindAnswer, b)
		a.gate.Lock()
		a.answered = true
		held := a.held
		a.held = nil
		a.gate.Unlock()
		for _, h := range held {
			a.send(KindICE, h)
		}
	case KindICE:
		var m ICEMessage
		if err := json.Unmarshal(data, &m); err != nil || m.Candidate == "" {
			return
		}
		_ = a.pc.AddICECandidate(pion.ICECandidateInit{Candidate: m.Candidate, SDPMid: m.SDPMid, SDPMLineIndex: m.SDPMLineIndex, UsernameFragment: m.UsernameFragment})
	}
}
