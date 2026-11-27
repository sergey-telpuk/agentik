package webrtc

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	pion "github.com/pion/webrtc/v4"

	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
)

const (
	// DefaultConnectTimeout bounds how long a phone has to open its
	// DataChannel after it attached to the relay. Past it the peer is
	// dropped and nothing is retried through the relay.
	DefaultConnectTimeout = 25 * time.Second

	// MaxPeers bounds simultaneous phone connections, matching the relay's
	// client limit.
	MaxPeers = 8

	// MaxBufferedBytes bounds what may queue toward one phone's DataChannel
	// before it is dropped as a slow receiver.
	MaxBufferedBytes = 256 * 1024

	// maxICEServerIssuesPerMinute caps how many times credentialed TURN
	// servers are handed out. Anyone who knows the device id can attach to the
	// relay, so the daemon rations credentials; see AGENTIK.md section 6.
	maxICEServerIssuesPerMinute = 30
)

var (
	// ErrNotOpen is returned by SendFrame when the connection has no open
	// DataChannel. Frames are never rerouted anywhere else.
	ErrNotOpen = errors.New("webrtc: data channel is not open")
	// ErrFrameTooLarge is returned for a frame above the 32 KiB limit.
	ErrFrameTooLarge = errors.New("webrtc: frame exceeds the data channel frame limit")
	// ErrSlowPeer is returned when a phone is not draining its DataChannel.
	ErrSlowPeer = errors.New("webrtc: peer is not draining its data channel")
)

// Sessions is the Noise layer the acceptor feeds. *secure.Manager implements it.
type Sessions interface {
	HandlePeerState(ctx context.Context, connectionID string, present bool)
	HandleFrame(ctx context.Context, connectionID string, frame []byte)
	CloseConnection(connectionID string)
}

// Config configures an Acceptor.
type Config struct {
	DeviceID []byte
	Signaler Signaler
	ICE      ICEConfig
	// TURNProvider mints TURN credentials through a provider's API instead of
	// from a shared secret. Nil keeps the coturn derivation in ICE. When it
	// fails, the configured STUN servers are sent on their own.
	TURNProvider TURNProvider
	// ConnectTimeout is how long a phone has to open its DataChannel; zero
	// means DefaultConnectTimeout.
	ConnectTimeout time.Duration
	// API builds the peer connections. Nil selects pion defaults; tests pass
	// one that allows loopback candidates.
	API *pion.API
	// OnEvent receives one-line diagnostics (never signal or frame contents).
	OnEvent func(connectionID, event string)
	// Now is the clock for credential rationing, replaceable in tests.
	Now func() time.Time
}

// Acceptor answers phones' WebRTC offers and runs their DataChannels.
//
// It is also the secure.FrameSender of the daemon: SendFrame writes to the
// DataChannel of one connection and to nothing else.
type Acceptor struct {
	cfg Config
	api *pion.API

	mu       sync.Mutex
	sessions Sessions
	peers    map[string]*peer
	closed   bool

	issueWindowStart time.Time
	issueCount       int
}

type peer struct {
	id        string
	ctx       context.Context
	createdAt time.Time

	mu       sync.Mutex
	pc       *pion.PeerConnection
	dc       *pion.DataChannel
	open     bool
	closed   bool
	offered  bool
	prologue []byte
	timer    *time.Timer

	// Candidates are held back until the answer has been sent, so the phone
	// never receives a candidate before it has a remote description.
	sigMu      sync.Mutex
	answerSent bool
	pendingICE [][]byte
}

// NewAcceptor validates cfg and returns an Acceptor with no sessions attached;
// call SetSessions before the first peer arrives.
func NewAcceptor(cfg Config) (*Acceptor, error) {
	if len(cfg.DeviceID) != 32 {
		return nil, errors.New("webrtc: device id must be 32 bytes")
	}
	if cfg.Signaler == nil {
		return nil, errors.New("webrtc: signaler is required")
	}
	if err := cfg.ICE.Validate(); err != nil {
		return nil, err
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = DefaultConnectTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	api := cfg.API
	if api == nil {
		api = pion.NewAPI()
	}
	return &Acceptor{cfg: cfg, api: api, peers: make(map[string]*peer)}, nil
}

// PeerStat describes one connected phone for the status display.
type PeerStat struct {
	// ConnectionID is the relay's id for this connection.
	ConnectionID string
	// Open is true once the DataChannel carries application data.
	Open bool
	// Since is when the connection was accepted.
	Since time.Time
}

// Peers reports the current connections, oldest first. It is a snapshot for
// display: a peer may close while the caller is formatting it.
func (a *Acceptor) Peers() []PeerStat {
	a.mu.Lock()
	peers := make([]*peer, 0, len(a.peers))
	for _, p := range a.peers {
		peers = append(peers, p)
	}
	a.mu.Unlock()

	stats := make([]PeerStat, 0, len(peers))
	for _, p := range peers {
		stats = append(stats, PeerStat{ConnectionID: p.id, Open: p.isOpen(), Since: p.createdAt})
	}
	sort.Slice(stats, func(i, j int) bool { return stats[i].Since.Before(stats[j].Since) })
	return stats
}

// SetSessions attaches the Noise layer. It must be set before peers arrive.
func (a *Acceptor) SetSessions(s Sessions) {
	a.mu.Lock()
	a.sessions = s
	a.mu.Unlock()
}

func (a *Acceptor) event(connID, format string, args ...any) {
	if a.cfg.OnEvent != nil {
		a.cfg.OnEvent(connID, fmt.Sprintf(format, args...))
	}
}

// HandleRegistered reconciles with the clients the relay lists after the
// daemon (re)registers. Peers whose DataChannel is already open are left
// alone: they no longer depend on the relay. Peers still signaling that the
// relay no longer lists are dropped, and listed clients get a peer.
func (a *Acceptor) HandleRegistered(ctx context.Context, connections []string) {
	listed := make(map[string]bool, len(connections))
	for _, id := range connections {
		listed[id] = true
	}
	a.mu.Lock()
	var stale []*peer
	for id, p := range a.peers {
		if !listed[id] && !p.isOpen() {
			stale = append(stale, p)
		}
	}
	a.mu.Unlock()
	for _, p := range stale {
		a.closePeer(p, "relay no longer lists this client")
	}
	for _, id := range connections {
		a.HandlePeerState(ctx, id, true)
	}
}

// HandlePeerState reacts to a client arriving at, or leaving, the relay.
//
// An arrival starts the connect timer and sends the ICE server list, so the
// phone can build its RTCPeerConnection. A departure drops a peer that has
// not opened its DataChannel yet; one that has is kept, since the relay is
// not on its data path.
func (a *Acceptor) HandlePeerState(ctx context.Context, connectionID string, present bool) {
	if !transport.ValidConnectionID(connectionID) {
		return
	}
	if !present {
		a.mu.Lock()
		p := a.peers[connectionID]
		a.mu.Unlock()
		if p != nil && !p.isOpen() {
			a.closePeer(p, "client left the relay before the data channel opened")
		}
		return
	}

	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	if existing := a.peers[connectionID]; existing != nil {
		a.mu.Unlock()
		return
	}
	var evict *peer
	if len(a.peers) >= MaxPeers {
		for _, p := range a.peers {
			if !p.isOpen() && (evict == nil || p.createdAt.Before(evict.createdAt)) {
				evict = p
			}
		}
		if evict == nil {
			a.mu.Unlock()
			a.event(connectionID, "refused: too many open connections")
			return
		}
	}
	p := &peer{id: connectionID, ctx: ctx, createdAt: a.cfg.Now()}
	a.peers[connectionID] = p
	p.timer = time.AfterFunc(a.cfg.ConnectTimeout, func() {
		if !p.isOpen() {
			a.closePeer(p, fmt.Sprintf("data channel did not open within %s (ICE failed or no candidate pair)", a.cfg.ConnectTimeout))
		}
	})
	a.mu.Unlock()
	if evict != nil {
		a.closePeer(evict, "evicted to admit a newer client")
	}

	a.sendICEServers(ctx, p)
}

// TURNProvider supplies ICE servers with ready-made credentials.
type TURNProvider interface {
	Servers(ctx context.Context) ([]ICEServer, error)
}

// iceServers is the list to hand to a phone: the provider's when one is
// configured and answers, otherwise the locally derived list.
func (a *Acceptor) iceServers(ctx context.Context, p *peer) []ICEServer {
	if a.cfg.TURNProvider == nil {
		return a.cfg.ICE.Servers("agentik")
	}
	fetched, err := a.cfg.TURNProvider.Servers(ctx)
	if err != nil {
		// A TURN outage must not take the direct path down with it.
		a.event(p.id, "TURN provider unavailable, sending STUN only: %v", err)
		return (ICEConfig{STUNURLs: a.cfg.ICE.STUNURLs}).Servers("")
	}
	return fetched
}

func (a *Acceptor) sendICEServers(ctx context.Context, p *peer) {
	servers := a.iceServers(ctx, p)
	if !a.allowCredentialIssue() {
		// Over the ration: hand out STUN only, no credentials.
		servers = (ICEConfig{STUNURLs: a.cfg.ICE.STUNURLs}).Servers("")
		a.event(p.id, "TURN credential issue rate exceeded; sending STUN only")
	}
	if servers == nil {
		servers = []ICEServer{}
	}
	payload, err := encodeSignal(ICEServersMessage{V: SignalVersion, Servers: servers})
	if err != nil {
		a.event(p.id, "cannot encode ICE servers: %v", err)
		return
	}
	if err := a.cfg.Signaler.SendSignal(ctx, p.id, KindICEServers, payload); err != nil {
		a.event(p.id, "cannot send ICE servers: %v", err)
	}
}

func (a *Acceptor) allowCredentialIssue() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.cfg.Now()
	if now.Sub(a.issueWindowStart) >= time.Minute {
		a.issueWindowStart = now
		a.issueCount = 0
	}
	a.issueCount++
	return a.issueCount <= maxICEServerIssuesPerMinute
}

// HandleSignal processes one signaling payload from the phone behind
// connectionID. Payloads for an unknown connection and malformed ones are
// dropped; neither can open a DataChannel.
func (a *Acceptor) HandleSignal(ctx context.Context, connectionID, kind string, data []byte) {
	a.mu.Lock()
	p := a.peers[connectionID]
	a.mu.Unlock()
	if p == nil {
		a.event(connectionID, "signal %q for an unknown connection dropped", kind)
		return
	}
	switch kind {
	case KindOffer:
		if err := a.handleOffer(ctx, p, data); err != nil {
			a.closePeer(p, "offer rejected: "+err.Error())
		}
	case KindICE:
		a.handleICE(p, data)
	default:
		a.event(connectionID, "signal kind %q ignored", kind)
	}
}

func (a *Acceptor) handleOffer(ctx context.Context, p *peer, data []byte) error {
	p.mu.Lock()
	if p.offered || p.closed {
		p.mu.Unlock()
		return errors.New("an offer was already processed for this connection")
	}
	p.offered = true
	p.mu.Unlock()

	offerSDP, err := decodeSDP(data)
	if err != nil {
		return err
	}
	clientFP, err := ExtractFingerprint(offerSDP)
	if err != nil {
		return fmt.Errorf("offer: %w", err)
	}

	pc, err := a.api.NewPeerConnection(pion.Configuration{ICEServers: toPionServers(a.cfg.ICE.Servers("agentik-device"))})
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = pc.Close()
		return errors.New("connection closed")
	}
	p.pc = pc
	p.mu.Unlock()

	pc.OnICECandidate(func(c *pion.ICECandidate) { a.onLocalCandidate(ctx, p, c) })
	pc.OnConnectionStateChange(func(s pion.PeerConnectionState) {
		a.event(p.id, "peer connection %s", s)
		if s == pion.PeerConnectionStateFailed || s == pion.PeerConnectionStateClosed {
			go a.closePeer(p, "peer connection "+s.String())
		}
	})
	pc.OnDataChannel(func(dc *pion.DataChannel) { a.onDataChannel(p, dc) })

	if err := pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}
	local := pc.LocalDescription()
	if local == nil {
		return errors.New("no local description")
	}
	deviceFP, err := ExtractFingerprint(local.SDP)
	if err != nil {
		return fmt.Errorf("answer: %w", err)
	}

	// Bind both fingerprints into the Noise prologue before any frame can
	// arrive and before the answer leaves.
	prologue, err := secure.WebRTCPrologue(a.cfg.DeviceID, clientFP, deviceFP)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.prologue = prologue
	p.mu.Unlock()

	a.mu.Lock()
	sessions := a.sessions
	a.mu.Unlock()
	if sessions == nil {
		return errors.New("no secure sessions attached")
	}
	sessions.HandlePeerState(p.ctx, p.id, true)

	payload, err := encodeSignal(SDPMessage{V: SignalVersion, SDP: local.SDP})
	if err != nil {
		return err
	}
	if err := a.cfg.Signaler.SendSignal(ctx, p.id, KindAnswer, payload); err != nil {
		return fmt.Errorf("send answer: %w", err)
	}
	p.sigMu.Lock()
	p.answerSent = true
	pending := p.pendingICE
	p.pendingICE = nil
	p.sigMu.Unlock()
	for _, c := range pending {
		a.sendCandidate(ctx, p, c)
	}
	a.event(p.id, "answered the offer")
	return nil
}

func (a *Acceptor) onLocalCandidate(ctx context.Context, p *peer, c *pion.ICECandidate) {
	if c == nil {
		return
	}
	init := c.ToJSON()
	payload, err := encodeSignal(ICEMessage{
		V:                SignalVersion,
		Candidate:        init.Candidate,
		SDPMid:           init.SDPMid,
		SDPMLineIndex:    init.SDPMLineIndex,
		UsernameFragment: init.UsernameFragment,
	})
	if err != nil {
		return
	}
	p.sigMu.Lock()
	if !p.answerSent {
		p.pendingICE = append(p.pendingICE, payload)
		p.sigMu.Unlock()
		return
	}
	p.sigMu.Unlock()
	a.sendCandidate(ctx, p, payload)
}

func (a *Acceptor) sendCandidate(ctx context.Context, p *peer, payload []byte) {
	if err := a.cfg.Signaler.SendSignal(ctx, p.id, KindICE, payload); err != nil {
		a.event(p.id, "cannot send ICE candidate: %v", err)
	}
}

func (a *Acceptor) handleICE(p *peer, data []byte) {
	m, err := decodeICE(data)
	if err != nil {
		a.event(p.id, "malformed ICE candidate dropped")
		return
	}
	p.mu.Lock()
	pc := p.pc
	p.mu.Unlock()
	if pc == nil {
		a.event(p.id, "ICE candidate before the offer dropped")
		return
	}
	if m.Candidate == "" {
		return // end of candidates
	}
	if err := pc.AddICECandidate(pion.ICECandidateInit{
		Candidate:        m.Candidate,
		SDPMid:           m.SDPMid,
		SDPMLineIndex:    m.SDPMLineIndex,
		UsernameFragment: m.UsernameFragment,
	}); err != nil {
		a.event(p.id, "cannot add ICE candidate: %v", err)
	}
}

func (a *Acceptor) onDataChannel(p *peer, dc *pion.DataChannel) {
	// Noise needs a reliable, ordered byte stream of whole messages. Anything
	// else, or a second channel, is refused.
	reliable := dc.Ordered() && dc.MaxRetransmits() == nil && dc.MaxPacketLifeTime() == nil
	p.mu.Lock()
	second := p.dc != nil
	if !second && dc.Label() == DataChannelLabel && reliable {
		p.dc = dc
	}
	accepted := p.dc == dc
	p.mu.Unlock()
	if !accepted {
		a.event(p.id, "data channel %q refused", dc.Label())
		_ = dc.Close()
		return
	}

	dc.OnOpen(func() {
		p.mu.Lock()
		p.open = true
		if p.timer != nil {
			p.timer.Stop()
		}
		p.mu.Unlock()
		a.event(p.id, "data channel open")
	})
	dc.OnClose(func() { go a.closePeer(p, "data channel closed") })
	dc.OnMessage(func(msg pion.DataChannelMessage) {
		if msg.IsString || len(msg.Data) == 0 || len(msg.Data) > secure.MaxMessageSize {
			go a.closePeer(p, "invalid data channel message")
			return
		}
		a.mu.Lock()
		sessions := a.sessions
		a.mu.Unlock()
		if sessions != nil {
			sessions.HandleFrame(p.ctx, p.id, append([]byte(nil), msg.Data...))
		}
	})
}

// Prologue returns the Noise prologue bound to one connection's DTLS
// fingerprints. It fails for a connection whose offer has not been processed,
// which aborts that connection's handshake. It is the secure.ManagerConfig
// Prologue callback.
func (a *Acceptor) Prologue(connectionID string) ([]byte, error) {
	a.mu.Lock()
	p := a.peers[connectionID]
	a.mu.Unlock()
	if p == nil {
		return nil, errors.New("webrtc: unknown connection")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.prologue == nil {
		return nil, errors.New("webrtc: no DTLS fingerprints known for this connection")
	}
	return append([]byte(nil), p.prologue...), nil
}

// SendFrame writes one encrypted frame to the DataChannel of connectionID. It
// is the only way application bytes leave the daemon, and it has no other
// route: with no open DataChannel it returns ErrNotOpen.
func (a *Acceptor) SendFrame(_ context.Context, connectionID string, data []byte) error {
	if len(data) == 0 || len(data) > secure.MaxMessageSize {
		return ErrFrameTooLarge
	}
	a.mu.Lock()
	p := a.peers[connectionID]
	a.mu.Unlock()
	if p == nil {
		return ErrNotOpen
	}
	p.mu.Lock()
	dc, open := p.dc, p.open
	p.mu.Unlock()
	if dc == nil || !open || dc.ReadyState() != pion.DataChannelStateOpen {
		return ErrNotOpen
	}
	if dc.BufferedAmount() > MaxBufferedBytes {
		go a.closePeer(p, "peer is not draining its data channel")
		return ErrSlowPeer
	}
	return dc.Send(data)
}

// Connected reports whether connectionID has an open DataChannel.
func (a *Acceptor) Connected(connectionID string) bool {
	a.mu.Lock()
	p := a.peers[connectionID]
	a.mu.Unlock()
	return p != nil && p.isOpen()
}

func (p *peer) isOpen() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.open && !p.closed
}

func (a *Acceptor) closePeer(p *peer, reason string) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	pc := p.pc
	if p.timer != nil {
		p.timer.Stop()
	}
	p.mu.Unlock()

	a.mu.Lock()
	if a.peers[p.id] == p {
		delete(a.peers, p.id)
	}
	sessions := a.sessions
	a.mu.Unlock()

	if sessions != nil {
		sessions.CloseConnection(p.id)
	}
	if pc != nil {
		_ = pc.Close()
	}
	a.event(p.id, "closed: %s", reason)
}

// CloseConnection drops one connection, for example when its phone is revoked.
func (a *Acceptor) CloseConnection(connectionID string) {
	a.mu.Lock()
	p := a.peers[connectionID]
	a.mu.Unlock()
	if p != nil {
		a.closePeer(p, "closed by the daemon")
	}
}

// Close drops every connection.
func (a *Acceptor) Close() {
	a.mu.Lock()
	a.closed = true
	peers := make([]*peer, 0, len(a.peers))
	for _, p := range a.peers {
		peers = append(peers, p)
	}
	a.mu.Unlock()
	for _, p := range peers {
		a.closePeer(p, "daemon shutting down")
	}
}

func toPionServers(in []ICEServer) []pion.ICEServer {
	out := make([]pion.ICEServer, 0, len(in))
	for _, s := range in {
		ps := pion.ICEServer{URLs: s.URLs}
		if s.Username != "" {
			ps.Username = s.Username
			ps.Credential = s.Credential
		}
		out = append(out, ps)
	}
	return out
}
