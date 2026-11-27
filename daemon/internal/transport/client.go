package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// State describes the daemon-to-relay connection lifecycle.
type State string

const (
	StateStopped      State = "stopped"
	StateConnecting   State = "connecting"
	StateConnected    State = "connected"
	StateReconnecting State = "reconnecting"
	StateFailed       State = "failed"
)

// Status snapshots the current transport state.
type Status struct {
	State       State
	RelayID     string
	Attempt     int
	NextRetryIn time.Duration
	LastError   string
}

// Handlers receives relay lifecycle and signaling events synchronously from the
// active socket's read loop or state transitions. Implementations must return
// promptly and not block indefinitely.
type Handlers struct {
	OnStatus       func(Status)
	OnRegistered   func(deviceID string, connections []string)
	OnDisconnected func()
	OnPeerState    func(connectionID string, present bool)
	OnSignal       func(connectionID, kind string, data []byte)
	OnRelayError   func(code, message, connectionID string)
	// OnTURN receives the credentials the relay minted, and how long they
	// last. The relay holds the key, so no user configures one.
	OnTURN func(servers []InboundICEServer, expiresIn int)
	// WantTURN reports whether this device needs TURN credentials at all.
	// A computer with no paired phone has nobody to connect to, so asking
	// would spend the relay's TURN quota on a device that cannot use it.
	WantTURN func() bool
}

// Config configures a transport Client.
type Config struct {
	RelayURL string
	Identity *identity.Identity
	// ExpectedRelayID, if non-empty, requires the relay's challenge to declare
	// this exact relayId before the daemon signs a registration for it.
	ExpectedRelayID string
	Handlers        Handlers
	HTTPClient      *http.Client
	Backoff         BackoffConfig
	DialTimeout     time.Duration
	RegisterTTL     time.Duration
	PingInterval    time.Duration
	PongTimeout     time.Duration
	StableAfter     time.Duration
	Now             func() time.Time
	// StopOnReplaced stops reconnecting if the relay closes with code 4000
	// (another socket proved the same registration key and replaced this one).
	StopOnReplaced bool
}

// Client maintains a registered outbound WebSocket connection to the relay.
type Client struct {
	cfg      Config
	relayURL string

	mu     sync.RWMutex
	status Status
	conn   *activeConn
}

type activeConn struct {
	ws         *websocket.Conn
	generation uint64
	writeMu    sync.Mutex
	closed     chan struct{}
	closeOnce  sync.Once
}

func (a *activeConn) markClosed() {
	a.closeOnce.Do(func() {
		close(a.closed)
	})
}

func (a *activeConn) writeText(ctx context.Context, data []byte) error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	return a.ws.Write(ctx, websocket.MessageText, data)
}

// NewClient validates cfg and returns a stopped transport Client.
func NewClient(cfg Config) (*Client, error) {
	if cfg.Identity == nil {
		return nil, errors.New("transport: identity is required")
	}
	connectURL, err := buildConnectURL(cfg.RelayURL, cfg.Identity.DeviceIDString())
	if err != nil {
		return nil, err
	}
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = 10 * time.Second
	}
	if cfg.RegisterTTL <= 0 {
		cfg.RegisterTTL = 30 * time.Second
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = 25 * time.Second
	}
	if cfg.PongTimeout <= 0 {
		cfg.PongTimeout = 10 * time.Second
	}
	if cfg.StableAfter <= 0 {
		cfg.StableAfter = 10 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	cfg.Backoff = cfg.Backoff.withDefaults()

	return &Client{
		cfg:      cfg,
		relayURL: connectURL,
		status:   Status{State: StateStopped},
	}, nil
}

func buildConnectURL(baseURL, deviceIDText string) (string, error) {
	if baseURL == "" {
		return "", errors.New("transport: relay URL is required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("transport: invalid relay URL: %w", err)
	}
	if u.Scheme != "wss" && u.Scheme != "ws" {
		return "", fmt.Errorf("transport: relay URL scheme %q must be wss or ws", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("transport: relay URL host is empty")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("transport: relay URL must not contain credentials, query, or fragment")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v1/connect"
	q := u.Query()
	q.Set("device", deviceIDText)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// URL returns the WebSocket endpoint URL including `/v1/connect?device=...`.
func (c *Client) URL() string {
	return c.relayURL
}

// Status returns a snapshot of the current transport state.
func (c *Client) Status() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.status
}

func (c *Client) setStatus(next Status) {
	c.mu.Lock()
	c.status = next
	c.mu.Unlock()
	if c.cfg.Handlers.OnStatus != nil {
		c.cfg.Handlers.OnStatus(next)
	}
}

// Run connects to the relay and keeps the route registered until ctx is
// cancelled or the relay returns a permanent protocol failure.
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	var generation uint64

	for {
		if ctx.Err() != nil {
			c.setStatus(Status{State: StateStopped})
			return ctx.Err()
		}

		generation++
		c.setStatus(Status{
			State:   StateConnecting,
			Attempt: attempt,
		})

		connectedAt := c.cfg.Now()
		res := c.runOnce(ctx, generation)

		if ctx.Err() != nil {
			c.setStatus(Status{State: StateStopped})
			return ctx.Err()
		}
		if res.fatal != nil {
			c.setStatus(Status{
				State:     StateFailed,
				Attempt:   attempt,
				LastError: res.fatal.Error(),
			})
			return res.fatal
		}
		if res.registered && c.cfg.Now().Sub(connectedAt) >= c.cfg.StableAfter {
			attempt = 0
		}

		delay := ComputeBackoffDelay(attempt, c.cfg.Backoff)
		attempt++
		lastErr := ""
		if res.err != nil {
			lastErr = res.err.Error()
		}
		c.setStatus(Status{
			State:       StateReconnecting,
			Attempt:     attempt,
			NextRetryIn: delay,
			LastError:   lastErr,
		})

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			c.setStatus(Status{State: StateStopped})
			return ctx.Err()
		case <-timer.C:
		}
	}
}

type runOutcome struct {
	registered bool
	fatal      error
	err        error
}

func (c *Client) runOnce(ctx context.Context, generation uint64) runOutcome {
	dialCtx, cancelDial := context.WithTimeout(ctx, c.cfg.DialTimeout)
	defer cancelDial()

	opts := &websocket.DialOptions{}
	if c.cfg.HTTPClient != nil {
		opts.HTTPClient = c.cfg.HTTPClient
	}
	ws, _, err := websocket.Dial(dialCtx, c.relayURL, opts)
	if err != nil {
		return runOutcome{err: err}
	}
	// Match relay's maxMessageLength(32 KiB) with comfortable read headroom.
	ws.SetReadLimit(64 * 1024)

	conn := &activeConn{
		ws:         ws,
		generation: generation,
		closed:     make(chan struct{}),
	}
	defer func() {
		conn.markClosed()
		c.clearActiveConn(conn)
		_ = ws.Close(websocket.StatusNormalClosure, "daemon closing")
	}()

	// Step 1: read challenge and sign registration within DialTimeout.
	regTimeoutCtx, cancelReg := context.WithTimeout(ctx, c.cfg.DialTimeout)
	challenge, err := c.readChallenge(regTimeoutCtx, ws)
	if err != nil {
		cancelReg()
		return runOutcome{err: err}
	}
	if c.cfg.ExpectedRelayID != "" && challenge.RelayID != c.cfg.ExpectedRelayID {
		cancelReg()
		return runOutcome{
			fatal: fmt.Errorf("transport: unexpected relay id %q, want %q", challenge.RelayID, c.cfg.ExpectedRelayID),
		}
	}

	if err := c.sendRegister(regTimeoutCtx, conn, challenge); err != nil {
		cancelReg()
		return runOutcome{err: err}
	}

	registeredMsg, fatalErr, err := c.readRegistered(regTimeoutCtx, ws)
	cancelReg()
	if fatalErr != nil {
		return runOutcome{fatal: fatalErr}
	}
	if err != nil {
		return runOutcome{err: err}
	}

	if registeredMsg.DeviceID != c.cfg.Identity.DeviceIDString() {
		return runOutcome{
			err: fmt.Errorf("transport: relay confirmed wrong device id %q", registeredMsg.DeviceID),
		}
	}

	// Route is now active: publish conn for SendSignal and notify handlers.
	c.setActiveConn(conn)
	c.setStatus(Status{
		State:   StateConnected,
		RelayID: challenge.RelayID,
	})
	// Ask for TURN credentials before announcing the registration: the
	// clients already attached are handed an ICE server list as soon as they
	// are known, and a list sent before the credentials arrive has no relayed
	// candidate in it.
	// Ask for TURN credentials now that the socket is a registered device:
	// that registration signature is what entitles it to them. The answer
	// arrives on the read loop below, and a relay without a TURN key simply
	// reports that, leaving direct paths and STUN to do the work.
	if c.cfg.Handlers.OnTURN != nil && (c.cfg.Handlers.WantTURN == nil || c.cfg.Handlers.WantTURN()) {
		// Best effort: a relay that cannot answer leaves direct paths and
		// STUN to do the work, which is not a reason to drop the session.
		_ = conn.writeText(ctx, []byte(`{"type":"turn"}`))
	}

	if c.cfg.Handlers.OnRegistered != nil {
		c.cfg.Handlers.OnRegistered(registeredMsg.DeviceID, append([]string(nil), registeredMsg.Connections...))
	}

	// Start keepalive loop and run read loop until disconnect/cancel.
	pongCh := make(chan struct{}, 1)
	keepaliveErrCh := make(chan error, 1)
	keepaliveCtx, cancelKeepalive := context.WithCancel(ctx)
	defer cancelKeepalive()

	go c.keepaliveLoop(keepaliveCtx, conn, pongCh, keepaliveErrCh)

	readErr, fatalReadErr := c.readLoop(ctx, ws, pongCh)
	cancelKeepalive()
	c.clearActiveConn(conn)
	if c.cfg.Handlers.OnDisconnected != nil {
		c.cfg.Handlers.OnDisconnected()
	}

	if fatalReadErr != nil {
		return runOutcome{registered: true, fatal: fatalReadErr}
	}
	if readErr != nil {
		return runOutcome{registered: true, err: readErr}
	}
	select {
	case kErr := <-keepaliveErrCh:
		return runOutcome{registered: true, err: kErr}
	default:
		return runOutcome{registered: true}
	}
}

func (c *Client) readChallenge(ctx context.Context, ws *websocket.Conn) (*inboundEnvelope, error) {
	msgType, raw, err := ws.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("transport: read challenge: %w", err)
	}
	if msgType != websocket.MessageText {
		return nil, errors.New("transport: challenge frame must be text")
	}
	msg, err := decodeInbound(raw)
	if err != nil {
		return nil, err
	}
	if msg.Type != "challenge" {
		if msg.Type == "error" {
			return nil, fmt.Errorf("transport: relay error %s: %s", msg.Code, msg.Message)
		}
		return nil, fmt.Errorf("transport: expected challenge, got %q", msg.Type)
	}
	if msg.RelayID == "" {
		return nil, errors.New("transport: challenge missing relayId")
	}
	challengeBytes, err := decodeStdBase64(msg.Challenge)
	if err != nil || len(challengeBytes) != protocol.ChallengeSize {
		return nil, errors.New("transport: invalid challenge payload")
	}
	return msg, nil
}

func (c *Client) sendRegister(ctx context.Context, conn *activeConn, challenge *inboundEnvelope) error {
	challengeBytes, err := decodeStdBase64(challenge.Challenge)
	if err != nil {
		return err
	}
	req := &protocol.RegisterRequest{
		Version:           protocol.Version,
		Role:              protocol.RoleDevice,
		RelayID:           challenge.RelayID,
		DeviceID:          c.cfg.Identity.DeviceID(),
		RegisterPublicKey: c.cfg.Identity.RegisterPublicKey(),
		Challenge:         challengeBytes,
		ExpiresAt:         c.cfg.Now().Add(c.cfg.RegisterTTL),
	}
	if err := req.Sign(c.cfg.Identity.RegisterPrivateKey()); err != nil {
		return fmt.Errorf("transport: sign registration: %w", err)
	}

	wire := outboundRegister{
		Type:              "register",
		Version:           req.Version,
		Role:              string(req.Role),
		RelayID:           req.RelayID,
		DeviceID:          base64.StdEncoding.EncodeToString(req.DeviceID),
		RegisterPublicKey: base64.StdEncoding.EncodeToString(req.RegisterPublicKey),
		Challenge:         base64.StdEncoding.EncodeToString(req.Challenge),
		ExpiresAt:         req.ExpiresAt.Unix(),
		Signature:         base64.StdEncoding.EncodeToString(req.Signature),
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return err
	}
	return conn.writeText(ctx, payload)
}

func (c *Client) readRegistered(ctx context.Context, ws *websocket.Conn) (msg *inboundEnvelope, fatalErr, err error) {
	for {
		msgType, raw, err := ws.Read(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("transport: read registration reply: %w", err)
		}
		if msgType != websocket.MessageText {
			return nil, nil, errors.New("transport: registration reply must be text")
		}
		msg, err = decodeInbound(raw)
		if err != nil {
			return nil, nil, err
		}
		switch msg.Type {
		case "pong":
			continue
		case "registered":
			return msg, nil, nil
		case "error":
			if c.cfg.Handlers.OnRelayError != nil {
				c.cfg.Handlers.OnRelayError(msg.Code, msg.Message, msg.ConnectionID)
			}
			if isFatalRelayError(msg.Code) {
				return nil, fmt.Errorf("transport: fatal relay error %s: %s", msg.Code, msg.Message), nil
			}
			return nil, nil, fmt.Errorf("transport: registration rejected (%s): %s", msg.Code, msg.Message)
		default:
			return nil, nil, fmt.Errorf("transport: expected registered, got %q", msg.Type)
		}
	}
}

func (c *Client) readLoop(ctx context.Context, ws *websocket.Conn, pongCh chan<- struct{}) (err, fatalErr error) {
	for {
		msgType, raw, err := ws.Read(ctx)
		if err != nil {
			var cs websocket.CloseError
			if errors.As(err, &cs) && cs.Code == CloseReplaced && c.cfg.StopOnReplaced {
				return nil, fmt.Errorf("transport: route replaced by another connection (code %d)", cs.Code)
			}
			return err, nil
		}
		if msgType != websocket.MessageText {
			continue
		}
		msg, err := decodeInbound(raw)
		if err != nil {
			continue
		}

		switch msg.Type {
		case "pong":
			select {
			case pongCh <- struct{}{}:
			default:
			}
		case "turn":
			if c.cfg.Handlers.OnTURN != nil && len(msg.ICEServers) > 0 {
				c.cfg.Handlers.OnTURN(msg.ICEServers, msg.ExpiresIn)
			}
		case "peer_state":
			if msg.Present == nil || msg.ConnectionID == "" {
				continue
			}
			if c.cfg.Handlers.OnPeerState != nil {
				c.cfg.Handlers.OnPeerState(msg.ConnectionID, *msg.Present)
			}
		case "signal":
			if msg.ConnectionID == "" || !ValidInboundSignalKind(msg.Kind) {
				continue
			}
			data, err := decodeStdBase64(msg.Data)
			if err != nil || len(data) == 0 || len(data) > MaxSignalBytes {
				continue
			}
			if c.cfg.Handlers.OnSignal != nil {
				c.cfg.Handlers.OnSignal(msg.ConnectionID, msg.Kind, data)
			}
		case "error":
			if c.cfg.Handlers.OnRelayError != nil {
				c.cfg.Handlers.OnRelayError(msg.Code, msg.Message, msg.ConnectionID)
			}
			if isFatalRelayError(msg.Code) {
				return nil, fmt.Errorf("transport: fatal relay error %s: %s", msg.Code, msg.Message)
			}
		}
	}
}

func (c *Client) keepaliveLoop(ctx context.Context, conn *activeConn, pongCh <-chan struct{}, errCh chan<- error) {
	ticker := time.NewTicker(c.cfg.PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.closed:
			return
		case <-ticker.C:
			// Drain stale pongs before sending a new ping.
			for {
				select {
				case <-pongCh:
				default:
					goto sendPing
				}
			}
		sendPing:
			writeCtx, cancelWrite := context.WithTimeout(ctx, c.cfg.PongTimeout)
			err := conn.writeText(writeCtx, []byte(KeepalivePing))
			cancelWrite()
			if err != nil {
				select {
				case errCh <- fmt.Errorf("transport: write keepalive ping: %w", err):
				default:
				}
				_ = conn.ws.Close(websocket.StatusGoingAway, "keepalive send failed")
				return
			}

			timer := time.NewTimer(c.cfg.PongTimeout)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-conn.closed:
				timer.Stop()
				return
			case <-pongCh:
				timer.Stop()
			case <-timer.C:
				select {
				case errCh <- errors.New("transport: keepalive pong timeout"):
				default:
				}
				_ = conn.ws.Close(websocket.StatusGoingAway, "keepalive timeout")
				return
			}
		}
	}
}

func isFatalRelayError(code string) bool {
	return code == "unsupported_version"
}

func (c *Client) setActiveConn(conn *activeConn) {
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
}

func (c *Client) clearActiveConn(conn *activeConn) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	c.mu.Unlock()
}

// SendSignal forwards one opaque signaling payload to the client identified by
// connectionID over the currently registered relay connection.
//
// This is the only thing the daemon sends through the relay besides its
// registration and keepalive. There is no method for application data.
func (c *Client) SendSignal(ctx context.Context, connectionID, kind string, data []byte) error {
	if !ValidConnectionID(connectionID) {
		return ErrInvalidConnectionID
	}
	if !validDeviceSignalKind(kind) {
		return ErrSignalKind
	}
	if len(data) == 0 {
		return ErrSignalEmpty
	}
	if len(data) > MaxSignalBytes {
		return ErrSignalTooLarge
	}

	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return ErrNotConnected
	}

	wire := outboundSignal{
		Type:         "signal",
		Kind:         kind,
		Data:         base64.StdEncoding.EncodeToString(data),
		ConnectionID: connectionID,
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return err
	}
	if err := conn.writeText(ctx, payload); err != nil {
		return fmt.Errorf("transport: send signal: %w", err)
	}
	return nil
}

func validDeviceSignalKind(kind string) bool {
	for _, k := range DeviceSignalKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// ValidInboundSignalKind reports whether kind is one a client may send to the
// daemon.
func ValidInboundSignalKind(kind string) bool {
	return kind == SignalOffer || kind == SignalICE
}
