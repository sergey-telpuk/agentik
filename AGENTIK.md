# Agentik

## Document status

- Version: 0.1.
- Date: 27 November 2026.
- Repository: [sergey-telpuk/agentik](https://github.com/sergey-telpuk/agentik).
- Working branch: `main`.
- Target local directory: `~/Projects/agentik`.
- Status: design documentation for implementation. The capabilities below are requirements, not a claim about a finished or verified application.

## 1. Purpose

Agentik is an application inside Telegram for remotely controlling AI agents on your own computer. The user installs the local application once, pairs their phone, and then selects a computer, a project, and a task in the graphical interface of a Telegram Mini App.

**Core promise:** task execution, projects, and persistent history live on the user's computer. All application data flows directly between the Mini App and the computer over WebRTC, end-to-end encrypted. A shared cloud service only helps the two find each other (signaling) and stores no task history.

The product is built from scratch. Using libraries, standard protocols, and official agent interfaces is allowed; no competitor's codebase is used.

### 1.1. Settled decisions

| Area | Decision |
| --- | --- |
| Primary interface | Telegram Mini App, React and TypeScript |
| Local application | Go, a separate self-contained build for each supported platform |
| Local state | SQLite; keys in the OS secure store where one is available |
| Remote transport | WebRTC `RTCDataChannel` (reliable, ordered) between the Mini App and the local application. All application data uses it and nothing else |
| Cloud component | A single relay on Cloudflare Workers and Durable Objects, used for signaling only: SDP offer and answer, ICE candidates, the ICE server list, device registration and presence. It never carries application data |
| NAT traversal | STUN and TURN servers are configured on the computer. TURN is optional, but a network pair with no direct path cannot connect without one. Either the user runs their own (for example coturn on a VPS), or they point the daemon at Cloudflare Realtime TURN with a key id and an API token |
| Fallback | None. If the DataChannel cannot open, the connection fails with a stated reason. The relay never forwards application data |
| End-to-end encryption | Noise over the DataChannel, with both DTLS fingerprints bound into the Noise prologue |
| First agent | Codex installed and authorized on the PC, over App Server via stdio |
| Distribution | GitHub Releases; the Mini App offers only builds actually published |
| Development | Documentation and subsequent implementation in `main`, no force push |

The computer side uses Pion WebRTC; the Mini App uses the WebView's `RTCPeerConnection`. MQTT, Nostr, and a separate push provider are not used in this version.

This reverses the earlier decision to pass all remote traffic through the relay. The chosen trade-off is that the relay carries only small signaling messages and the data path is direct (or through the user's own TURN), at the price that a pair of networks with no direct path and no TURN server cannot connect at all. The user accepts that; there is no relay data fallback.

### 1.2. Limits of the promise

- A shared signaling relay exists; the user does not deploy their own signaling server. A TURN server is optional: it is either the user's own or a provider they configure, and its operator sees addresses, timing, and sizes of encrypted traffic.
- Without a direct network path between the phone and the computer, and without a working TURN server, the connection fails. There is no relay fallback.
- The phone stores its own access key and the list of paired computers. The displayed data is also held in the Mini App's memory.
- The relay provider sees signaling metadata: the network addresses in ICE candidates, timing, and signal sizes. It sees no application data, which never crosses it.
- The phone and the computer see each other's network addresses on a direct path. A TURN operator, if one is used, sees addresses, timing, and sizes of encrypted traffic, not its content.
- Codex and other cloud agents may send context to their AI provider. Running an agent locally does not mean the model runs locally.
- The computer must be powered on and connected to the network, and the local application must be running. Waking a sleeping or powered-off PC is out of scope for the first version.
- Free infrastructure quotas do not mean free operation at any scale, and do not cover the cost of models or of installer signing.

## 2. User scenario

### 2.1. Initial setup

1. The user opens Agentik inside Telegram and chooses "Connect a computer".
2. They select the OS and architecture of the target computer. The phone's OS is not used to pick the PC build automatically.
3. On the computer they open the link, download the application, and run it. Downloading the binary onto the phone does not by itself install it on the PC.
4. The local wizard creates the computer's identity, connects to the relay, and displays a pairing QR code.
5. The user scans the QR code from the Mini App on their phone.
6. On the computer they confirm this specific new device and the verified Telegram account, then select the permitted projects.
7. The Mini App receives the list of available projects and details of the installed agent directly from the PC.

Setting up the shared Mini App through BotFather is the developer's job. The user does not create their own bot and does not copy a Bot Token. Telegram provides the interfaces for launching a Mini App, scanning QR codes, and downloading files; their availability is verified on the supported clients. [S1]

### 2.2. Day-to-day use

1. Open Agentik and select a previously paired computer.
2. Wait for a confirmed secure connection.
3. Select a permitted project and an existing or new agent session.
4. Submit a task and watch its actual state.
5. Where needed, approve a specific operation, add a message, or request a stop.
6. Review the result and the file changes.

Closing the Mini App does not cancel a running task. On return, the interface restores state from the computer. An unreachable PC means neither success nor a stopped task.

## 3. System components

### 3.1. Mini App

The Mini App is responsible for the device, project, session, task, result, and approval screens. It verifies the pinned PC identity, establishes the Noise session, and displays state received from the local application.

Main screens:

| Screen | Main actions |
| --- | --- |
| Computers | Add a device, connect, see availability |
| Connect | Pick a build, scan the QR code, see the pairing outcome |
| Projects | Select a permitted project and an available agent |
| Session | Submit a task, read events, continue the dialogue |
| Approval | Review a specific operation and allow or reject it |
| Result | Read the response, view a bounded diff and execution status |
| Access | See pairings and revoke a phone according to local permissions |

Task history is not synchronized through Telegram CloudStorage. The list of PCs is stored locally on the phone; a new phone goes through its own pairing.

### 3.2. Local application

The Go application performs the following functions:

- local project and permission configuration;
- creating and storing the computer's identity;
- registering with the relay and reconnecting automatically;
- pairing, authenticating, and revoking phones;
- launching and managing the supported agent;
- persisting tasks, events, approvals, and results in SQLite;
- diagnosing connectivity and agent availability;
- verifying signed updates before installing them.

The application runs with ordinary user privileges. Autostart is enabled explicitly in the local wizard. The local configuration interface, if it uses HTTP, listens on loopback only and is protected against requests from other sites; it is not exposed through the relay.

### 3.3. Relay

The relay is a signaling service. It accepts outbound WSS connections from the computer and the Mini App, authenticates route registration, and forwards small opaque signaling payloads between one phone connection and the computer: the SDP offer and answer, ICE candidates, and the computer's ICE server list. It does not run commands, does not receive Noise keys, and carries no application data.

Signal kinds are fixed and directional: a phone may send `offer` and `ice`; the computer may send `answer`, `ice`, and `ice_servers`. The relay checks the kind, the size (32 KiB), and the direction, rate-limits each connection, and forwards the payload without interpreting it. There is no frame or data message type: a legacy `frame` message is rejected as an unknown type, so the relay cannot be used as a data path even by a modified client.

One Durable Object serves the connections of one computer. Its address is derived deterministically from the device identifier. No separate device-to-object mapping table is required.

Only the data needed for current connections is allowed on the relay side: roles, public identifiers, limits, challenges, and short-lived routes. Signaling payloads are not written to the Storage API or to logs. Connection attachments can survive hibernation; it cannot be promised that infrastructure metadata exists only in RAM. [S3]

The Hibernation WebSocket API is used. An open channel can persist while the handler is evicted; a message activates processing. Keepalive is implemented with platform facilities, without persistent server-side timers that would prevent hibernation. [S3]

Registration, the challenge, `attach`, and presence (`peer_state`) are unchanged. The phone leaves the relay as soon as its DataChannel is open; an open DataChannel does not depend on the relay afterwards.

## 4. Storage and entities

| Data | Storage location | Note |
| --- | --- | --- |
| Project source files | Computer | The user's ordinary file system |
| Tasks, history, events, results | SQLite on the computer | Source of truth for the interface |
| Project paths and permissions | Computer | Transmitted through the relay only inside Noise |
| AI agent keys and authorization | The agent's own local store | Not exported to an Agentik server |
| PC private keys | Computer | Not transmitted to the phone or the relay |
| Phone key | The phone's secure store | Availability verified per platform |
| List of PCs and pinned public keys | Mini App local storage | Not cloud synchronization |
| Current connection metadata | Relay | No task history |

Telegram provides DeviceStorage and SecureStorage. SecureStorage cannot be treated as protection against modified Mini App code: the application can read back a stored value. If supported secure storage is unavailable, a persistent key is not silently written to ordinary localStorage. The first version either offers an explicitly temporary session or reports that persistent access is not supported. [S1, S2]

### 4.1. Logical SQLite model

| Entity | Purpose |
| --- | --- |
| `trusted_clients` | Phone public key, Telegram ID, permissions, pairing and revocation dates |
| `projects` | Stable ID, display name, local path, permitted agent |
| `agent_sessions` | Dialogue context, project, adapter, and the agent's thread identifier |
| `tasks` | User request, execution state, links to session and result |
| `commands` | Deduplication: client, request ID, method, content hash, processing status |
| `events` | Ordered events with a sequence number within a session |
| `approvals` | Pending decisions on specific operations and their expiry |
| `pairing_invitations` | Hash of a one-time invitation, expiry, attempt count, state |

The schema is applied through migrations. A single platform data directory is chosen on the computer; the process's temporary working directory is not where history lives. Private keys are not written to SQLite in plaintext when an OS store is available. Any storage fallback must be described explicitly and verified for the platform.

The entities "connection", "agent session", and "task" are distinct: dropping a connection does not delete a session and does not cancel a task.

## 5. Identity and pairing

### 5.1. Key separation

The computer has two distinct cryptographic identities:

- Ed25519 — proof of ownership of the device address when registering with the relay;
- X25519 — the long-term Noise key for the secure channel with the phone.

These keys are not interchangeable. The QR code and the verifiable pairing descriptor bind them to one device. The proposed `device_id` is the SHA-256 of the relay registration public key in a fixed encoding.

The phone holds its own Noise identity. Knowing a `device_id`, a successful WebSocket, or even a verified Telegram ID does not grant the right to control the computer.

### 5.2. Registering a computer with the relay

1. The computer opens a WSS connection and presents its registration public key.
2. The relay issues a random, short-lived challenge bound to that socket.
3. The computer signs the context `agentik-relay-register-v1`, the role, the relay identifier, the `device_id`, the challenge, and the expiry.
4. The relay verifies the signature, the expiry, and that the challenge matches the current connection.
5. Only after verification does the connection become the computer's active route.

Signed data uses an unambiguous serialization: fixed field order and lengths, or a canonical encoding. Arbitrary JSON serialization is not used as an implicit signing contract.

An unauthorized connection does not evict a running daemon. Re-registration with proof of the same key replaces the old connection under an explicitly defined rule. Proof of possession protects the route, but separate limits are still required to prevent an attacker from mass-creating new devices.

### 5.3. Initial phone pairing

The QR code contains the version, the relay address, the registration public key (the computer identifier is its SHA-256), the Noise public key, a one-time high-entropy invitation secret, the expiry, and the computer's signature. The invitation travels over the secure channel, has a TTL, and is consumed after a successful confirmation. It is not placed in persistent URLs or logs. A short numeric code may serve as a verification display, but not as the sole access secret.

The invitation text is `AGENTIK1:` followed by unpadded uppercase RFC 4648 base32 of a binary payload. Prefix and base32 together stay inside the QR alphanumeric character set, the densest text mode a QR code offers. All integers are big-endian:

| Bytes | Field |
| --- | --- |
| 1 | Version, `1` |
| 1 | Relay selector: `0` the hosted relay (`wss://agentik-relay.agentikcl.workers.dev`), `1` a custom `wss://` relay, `2` a custom `ws://` loopback relay for development |
| 32 | Ed25519 registration public key; `device_id` = SHA-256 of it, not carried |
| 32 | X25519 Noise public key |
| 32 | Invitation secret; the invitation id = SHA-256 of it, not carried |
| 4 | Expiry, Unix seconds |
| 64 | Ed25519 signature of the `PairingDescriptor` (`agentik-pairing-descriptor-v1` canonical encoding: version, relay URL, `device_id`, both public keys, invitation id, expiry) |
| rest | Custom relay only: `host[:port][/path]` without the scheme |

With the hosted relay the payload is 166 bytes and the text 275 characters, which is QR version 10 at error correction level M (57 by 57 modules). A custom relay of up to 22 bytes after the scheme still fits version 10. Each invitation has exactly one encoding: the relay must already be normalised, and the hosted relay always uses selector `0`. Parsers ignore whitespace and letter case so a wrapped or retyped text still works, and reject anything else, including the earlier JSON format.

Both the daemon and the Mini App rebuild the descriptor and verify the signature against the registration key in the invitation, and both reject an expired invitation. The Mini App verifies it with WebCrypto Ed25519 and refuses the invitation where the WebView does not implement Ed25519. A valid signature only shows that the holder of that registration key published these keys and this relay together and that nothing was altered on the way. Anyone can sign a QR code with their own key, so access still depends on the Noise handshake and the local confirmation. A shared test vector in the Go and TypeScript suites keeps both parsers byte-compatible.

The daemon prints the QR code in the terminal with Unicode half-block characters and a four-module quiet zone, 65 columns by 33 lines, with the invitation text underneath for pasting. On a start with no paired phone it prints a short welcome text, the QR code, and a new code each time the previous one expires; once a phone is paired it prints one status line, and `-pair` or the `pair` command shows a code on demand.

The phone pins the PC's Noise key from the QR code. After the full handshake, the daemon verifies the invitation and the Telegram identity, then shows a local prompt. The user confirms this specific pending pairing and this specific phone public key.

| State | Access |
| --- | --- |
| `unpaired` | Connection interface only |
| `handshaking` | Cryptographic exchange, no agent commands |
| `awaiting_local_approval` | Waiting for a decision on the PC, no project reads |
| `paired` | Access within the stored local permissions |
| `expired` / `rejected` | A new attempt requires a valid invitation |
| `revoked` | Access terminated, no automatic restoration |

### 5.4. Telegram identity

The daemon verifies the raw `initData`: the Ed25519 signature, the expected `bot_id`, the format, and the freshness of `auth_date`. Telegram documents third-party verification without a Bot Token. `initDataUnsafe` is not treated as proof of identity. [S1]

The verified Telegram ID is bound to the phone key in the local permissions. The acceptable age of `initData` and the behaviour after a long open session are fixed in the protocol: an existing authenticated session does not become a way around verification, and a new connection requires a fresh Mini App launch where necessary.

### 5.5. Revocation and rotation

Revocation is performed on the PC: the key is marked revoked, its active channels are closed, and subsequent operations are rejected. Permissions are checked both at connection time and before a sensitive operation.

Changing the computer's key in v0.1 requires pairing again locally. A pinned-key mismatch is not resolved by automatically accepting the new key.

## 6. Secure protocol

### 6.1. Noise

The baseline profile for verifying the implementation is `Noise_XX_25519_ChaChaPoly_SHA256`. Noise XX supports transmitting static public keys and mutual authentication; the application must establish trust in those keys separately. [S6]

The phone checks the PC's key after the second XX message; the daemon checks the phone's key after the third. Agent commands are accepted only after the full handshake and local authorization. Commands in early handshake payloads and 0-RTT are not supported.

The prologue binds the Agentik protocol, the version, the roles, the target computer, and the two DTLS certificate fingerprints of the WebRTC connection (section 6.4). The connection context is verified so that messages cannot be replayed across different channels, and so that a party on the signaling path who swapped a fingerprint makes the handshake fail. After any reconnect a new WebRTC connection and a new handshake are performed; old nonces and transport keys are not restored.

Cryptographic primitives are not implemented in-house. A Go library with a shared native/WASM build is a candidate for the implementation, not an already-vetted dependency. Test vectors and compatibility with the target Telegram WebViews are required before a version is fixed.

### 6.2. Outer and inner messages

| Layer | Permitted content |
| --- | --- |
| Relay signaling message | Message type, signal kind (`offer`, `answer`, `ice`, `ice_servers`), opaque base64 payload (SDP, ICE candidate, ICE servers); never application data |
| DataChannel message | One Noise handshake message or one Noise ciphertext frame, at most 32 KiB, binary |
| Inner Noise message | Command, project parameters, task, text, result, diff, approval |

Signaling payloads contain no local paths, project names, prompts, or results. They determine how two peers connect, not what authority they have; authority is checked by the PC.

A draft example of an inner command, not a finished public API:

```json
{
  "v": 1,
  "request_id": "6f33271b-ecfb-4c5a-a4b9-c04cff80fda3",
  "method": "task.start",
  "params": {
    "project_id": "project_local_1",
    "session_id": null,
    "agent": "codex",
    "prompt": "Check the tests and propose a fix"
  }
}
```

`project_id` is resolved on the PC against the local project catalogue. An arbitrary path or shell command from the network does not become a daemon launch parameter.

### 6.3. v0.1 commands

| Method | Purpose |
| --- | --- |
| `device.info` | Details about the connected computer and its capabilities |
| `project.list` | Projects available to the current client |
| `agent.list` | Discovered agents and compatibility status |
| `session.list` / `session.open` | Working with local sessions |
| `task.start` | Creating a task with a mandatory request ID |
| `task.get` | Confirmed task state |
| `task.cancel` | A stop request; not an immediate confirmation of cancellation |
| `approval.resolve` | A decision on one specific pending operation |
| `events.resume` | Replaying events after a sequence number |
| `changes.get` | A bounded view of the resulting changes |

A session maps to one agent thread. `task.start` with `session_id: null` creates a session and a new thread; `task.start` with an existing `session_id` (it must belong to the same project and agent) runs the next turn on that thread through `thread/resume`. A continuation is deduplicated and checked for conflicts like any other `task.start`, and it is rejected with `project_busy` while another turn is active in the project. `session.open` with an existing `session_id` returns the session's turns (`tasks`, oldest first, bounded to fit one frame, with `tasks_truncated` when older turns were left out), so a client can render the conversation after a reconnect.

`agent.list` returns every agent CLI detected on the computer (Codex, Claude Code, Cursor Agent, and Gemini CLI when installed). Each entry keeps the original `name`, `available`, `authenticated`, `version`, `detail`, and `capabilities` fields and adds `id`, `display_name`, `status`, `status_text`, `supported`, and `models` (`id`, `display_name`, `description`, `is_default`) with `models_source` (`live` or `static`). `status` is `ready`, `not_authenticated`, `unknown` (the sign-in state could not be determined), `unsupported` (detected, but Agentik has no adapter for it yet; `status_text` gives the reason), or `not_installed` (supported but not found). Local binary paths are never sent. `task.start` accepts an optional `agent_id` (the same agent as the legacy `agent` field; if both are sent they must agree) and an optional `model`. A `model` must appear in the agent's current model list; an empty model means the agent's own default. An unknown agent, an unsupported agent, a model on an agent that is not ready, or an unlisted model is rejected with `agent_unavailable`, `agent_unsupported`, `agent_not_ready`, or `unknown_model`. The model is part of the content hash used for idempotency and is stored on the task, so a retry returns the original task with its original agent and model.
`session.list` takes an optional `project_id` (unknown project: `not_found`) and returns `sessions`, the most recently active sessions first, bounded to 50 entries and to fit one frame, with `sessions_truncated` when older sessions were left out. Each entry carries `session_id`, `project_id`, `agent`, `created_at`, `updated_at` and, additively, `title` (the first prompt, bounded), `latest_state` (the state of the newest turn) and `turn_count`. Sessions without any turn are not listed. A client that finds `session.list` unsupported (an older daemon answers with an unknown-method error) falls back to the sessions it started in the current run.

Method names and the JSON Schema are fixed before clients are implemented. An unknown version, method, extra dangerous parameters, or exceeded limits produce an explicit error.

### 6.4. WebRTC data path

**Roles.** The phone is the offerer and the computer is the answerer. The phone opens one reliable, ordered DataChannel labelled `agentik`; the computer accepts only that channel. Text messages and messages over 32 KiB close the peer.

**Connection setup.** Signaling uses trickle ICE over the relay:

1. The phone attaches to the relay for a computer. The relay tells the computer a client is present.
2. The computer sends `ice_servers`: its STUN URLs and, if TURN is configured, a TURN URL with time-limited credentials.
3. The phone creates an `RTCPeerConnection` with those servers, creates the DataChannel and an offer, and sends `offer`, then its ICE candidates as `ice`.
4. The computer sets the offer, creates the answer, binds the fingerprints (below), sends `answer`, then its candidates.
5. When the DataChannel opens, the phone leaves the relay. Noise XX runs over the DataChannel, then the inner protocol (including `auth.telegram` and `pair.submit`, which therefore never touch the relay).

The daemon limits concurrent peers, drops a peer whose DataChannel has not opened within a connect timeout, and drops one that stops draining its queue.

**TURN credentials.** Two schemes are supported, and in both the long-lived secret stays on the computer: only derived, time-limited credentials reach the phone.

With Cloudflare Realtime TURN the daemon posts to `rtc.live.cloudflare.com` with its key id and API token and forwards the returned `iceServers`. The list is cached until shortly before it expires, and a failure falls back to STUN rather than taking the direct path down. The API token is read from a file or the environment, never from a command-line value. URLs on port 53 are dropped: browsers block it.

With a self-run server TURN uses coturn's `use-auth-secret` scheme: the username is `<expiry unix seconds>:<label>` and the password is `base64(HMAC-SHA1(secret, username))`. The shared secret stays on the computer; only derived, time-limited credentials are sent to the phone. Because the `ice_servers` signal is sent to whoever attaches to the relay for that device identifier, anyone who knows a device identifier can obtain short-lived TURN credentials. This is mitigated, not prevented: credentials expire quickly (10 minutes by default), the computer issues credentialed lists at most 30 times per minute and falls back to STUN only beyond that, and the TURN server must set its own per-user quotas. A TURN operator who sees the credentials can relay encrypted traffic only; it cannot read or forge it.

**Fingerprint binding.** Each side reads the DTLS certificate fingerprint declared in the SDP it sent and the one it received (SHA-256 only; an SDP with several different fingerprints, or none, is refused). The Noise prologue is the canonical encoding of the context `agentik-noise-webrtc-prologue-v1`, the version, the roles `client` and `device`, the `device_id`, the phone's fingerprint, and the computer's fingerprint, in that order. DTLS alone authenticates only the fingerprint it was told, and the signaling path is not trusted: a relay or network attacker who rewrites both SDPs can terminate DTLS toward each side with its own certificate. The phone's and the computer's views of the two fingerprints then differ, so the prologues differ and the Noise handshake fails at the second message, before any application byte or phone identity is sent. The pinned computer key then binds the Noise static key to the right computer. The prologue encoding is pinned by a cross-language test vector (Go and TypeScript).

**No fallback.** If the DataChannel cannot open, the Mini App reports a failure with a reason and does not retry through the relay: `webrtc_unsupported` (the WebView has no `RTCPeerConnection`), `ice_failed` (ICE failed or the channel did not open in time, with no candidate pair), `relay_unreachable` (signaling could not be carried), `computer_offline`, or, after the channel was open, `link_lost`. The user can retry, which starts a new negotiation. The relay has no data message type, the daemon's relay client has no call that sends one, and the Mini App's relay client sends only `offer` and `ice`.

**Lifetime.** An open DataChannel survives the phone leaving the relay and the computer's relay connection dropping and re-registering. A closed DataChannel ends the session; recovery is a new negotiation, a new handshake, and `events.resume` (section 7.3).

**Configuration.** Nothing is tied to a provider.

| Where | Setting |
| --- | --- |
| Computer | `--relay` (env `AGENTIK_RELAY_URL`): the signaling URL carried in invitations |
| Computer | `--stun` (env `AGENTIK_STUN_URLS`), `--turn` (env `AGENTIK_TURN_URLS`): repeatable or comma-separated URLs |
| Computer | `--turn-secret-file` (env `AGENTIK_TURN_SECRET_FILE` or `AGENTIK_TURN_SECRET`): the coturn shared secret; required with `--turn`, never a command-line value |
| Computer | `--turn-key-id` (env `AGENTIK_TURN_KEY_ID`) and `--turn-token-file` (env `AGENTIK_TURN_TOKEN_FILE` or `AGENTIK_TURN_TOKEN`): Cloudflare Realtime TURN instead of a self-run server |
| Computer | `--turn-ttl` (env `AGENTIK_TURN_TTL`), `--connect-timeout` (env `AGENTIK_CONNECT_TIMEOUT`) |
| Mini App build | `VITE_AGENTIK_STUN_URLS`: extra static STUN URLs; `VITE_AGENTIK_CONNECT_TIMEOUT_MS`, `VITE_AGENTIK_ICE_SERVERS_WAIT_MS`. TURN is not configured here: the computer supplies credentials |

## 7. Tasks, deduplication, and recovery

### 7.1. Task states

| State | Meaning |
| --- | --- |
| `accepted` | The request was validated and written to SQLite |
| `starting` | Launch has begun, execution is not yet confirmed |
| `running` | The agent confirmed execution |
| `awaiting_approval` | Waiting for a decision on an operation |
| `cancel_requested` | A stop was requested, termination is not yet confirmed |
| `succeeded` | The agent reported successful completion |
| `failed` | A confirmed error was received |
| `cancelled` | The stop was confirmed |
| `recovery_required` | After a crash, the result or the continuity of execution is unknown |

For v0.1, one active task per working directory is allowed. A second launch receives a clear "busy" status. Parallel work across different projects is bounded by local configuration.

### 7.2. Idempotency

The `accepted` acknowledgement is sent after the command has been successfully written to SQLite. Uniqueness is defined by the pair (client identity, request ID); the method and the hash of the canonical content are stored as well.

- A repeat with the same content returns the existing task and its state.
- The same request ID with different content is rejected as a conflict.
- Reconnecting does not by itself create a new task.

**Exactly-once launch of an external process is not promised.** There is a failure window between the OS operation and the SQLite write. The runtime records the intent to launch, links it to the agent's thread identifier, and reconciles state after a crash. If the result cannot be established, the task becomes `recovery_required` and is not relaunched automatically. A PID alone is not enough to identify a process reliably.

### 7.3. Connection recovery

A working connection passes through the states `disconnected`, `signaling` (relay attached, offer and answer exchanged), `link_open` (DataChannel open, relay released), `handshaking`, `authenticated`, `synchronizing`, `ready`.

On a disconnect the agent keeps running as long as the PC and the daemon are running. A closed DataChannel ends the Mini App's attempt with `link_lost` and a Retry action; a retry runs signaling, a new DTLS connection, a new handshake, authentication, and a request for events after the last processed sequence number. Signaling reconnects while the channel is still opening use bounded exponential backoff and jitter.

Sequence numbers are monotonic within a session. If old events were removed by the local retention policy, the PC returns a state snapshot and a new cursor. The interface does not substitute missing events with a claim that the task finished successfully.

A relay restart or outage must not affect local execution or an already open DataChannel; new connections wait for signaling to return. A daemon restart is a separate failure scenario: whether the process survives and whether control can be recovered depends on the agent and the OS, and must be verified.

### 7.4. Approvals

An approval is bound to a task ID, a session ID, a unique approval ID, the exact action, and an expiry. A repeated or expired decision is rejected. A rejection applies to the requested operation; losing the phone does not imply automatic approval.

## 8. Agent integration and access limits

The first adapter implemented is the Codex App Server over stdio. The App Server documents the JSONL transport, initialization, threads, and turns. Its port is not exposed to the internet: Agentik works with a local child process. [S7]

The adapter must:

- discover the binary and verify a supported version;
- diagnose a missing installation or missing authorization;
- create and resume supported sessions;
- translate events into the Agentik protocol;
- relay approval decisions and stop requests;
- maintain the link between the local session and the agent thread;
- distinguish the end of a turn from process exit and from transport loss.

Agents are detected by running only each CLI's own read-only `--version` and sign-in status commands under a short timeout; credential and key files are never read, and a status command's output is reduced to a fixed readiness value and not retained. When a CLI has no known non-interactive status command its readiness is reported as unknown rather than guessed. An agent gets an adapter only when its non-interactive protocol can carry Agentik's approval and recovery rules. In this version only Codex is supported. Claude Code is detected but unsupported: its stream-json mode needs a host-side permission tool that is not implemented. Cursor Agent is detected but unsupported: its print mode runs all tools, including write and shell, without asking. The Codex model list is read from the App Server (`model/list`); if that query fails the list is an empty, labelled static fallback and only the agent's default model can be used, because no model identifier is guessed.

The general session model must not assume that every future CLI supports the same kind of resumption. Capabilities are declared explicitly by the adapter.

A permitted project and a Git worktree are not a sandbox. If the agent runs a shell with the user's privileges, checking the working directory alone is not enough. Agentik preserves the agent's own restrictions and the applicable OS mechanisms, and does not enable global automatic approval. Path checks account for symlinks and escapes from the permitted area wherever the application itself reads or serves files.

Agent output is treated as untrusted content: HTML and Markdown must not execute code in the Mini App. Server messages are likewise not used as launch commands or shell parameters.

### 8.1. Remote terminal

This deliberately reverses the earlier "no shell from the phone" stance: a paired phone can open a full interactive shell on the computer, with no per-command or per-session confirmation, so a paired phone is as powerful as the user at the keyboard. The shell runs in a chosen project directory and the user can run any command there, including an interactive agent such as `codex`.

| Method | Request | Result |
| --- | --- | --- |
| `terminal.open` | `project_id`, optional `command`, `cols`, `rows` | `session_id`, `project_id`, `cols`, `rows` |
| `terminal.input` | `session_id`, `data` (standard base64, at most 4 KiB decoded) | `session_id`, `bytes` |
| `terminal.resize` | `session_id`, `cols`, `rows` | `session_id`, `cols`, `rows` |
| `terminal.read` | `session_id`, `after_seq`, optional `wait_ms` (at most 25000) | `session_id`, `chunks` (`seq`, base64 `data`), `next_seq`, `closed`, `reason`, `exit_code`, `truncated` |
| `terminal.close` | `session_id` | `session_id`, `closed`, `reason`, `exit_code` |

Output is pulled, like `events.resume`, rather than pushed. `terminal.read` acknowledges every chunk up to `after_seq`, returns the chunks after it (at most 16 KiB of raw output and 64 chunks, so a response always fits one frame), and with nothing to return waits up to `wait_ms` for output; a newer read on the same session ends an older waiting one. A lost response is recovered by repeating the read with the same cursor. `closed` is set once the session has ended and no output is left; `reason` is `exited`, `closed`, `idle`, `disconnected`, `revoked`, or `shutdown`. The optional `command` (one printable line, at most 1 KiB) is typed into the shell after it starts, so it runs exactly as if the user typed it.

Safety baselines, all mandatory:

- Terminal methods pass the same per-request paired-phone check as every other command; an unpaired, pending, or revoked phone gets `unauthorized` and no shell. A session belongs to the Noise channel that opened it; another channel, even of the same phone, gets `not_found`.
- Closing that channel (relay disconnect, phone reconnect) or revoking the phone ends every terminal session of that phone and frees its PTY. Revocation waits until the processes are gone.
- The working directory is the symlink-resolved root of a project from the local catalogue (`-project id=path`). `terminal.open` accepts no path, shell, or environment parameter.
- Output is buffered per session up to 256 KiB of unacknowledged data. When the phone does not keep up, the daemon stops reading the PTY and the kernel blocks the shell, so memory stays bounded. Input goes through a bounded queue; a full queue answers `terminal_busy` instead of blocking the daemon. Requests that may wait (`terminal.read` with `wait_ms`, `terminal.close`) are answered from a goroutine so they never hold up other frames.
- Each session is a new OS session and process group. Ending it sends SIGHUP to the shell's group and to the terminal's foreground group, SIGKILL after one second, and closes the PTY. Daemon shutdown ends every session first. Jobs the user explicitly detached into another process group (`nohup`, `disown`) are not tracked.
- Only lifecycle facts are logged: session id, project id, pid, close reason, and exit code. Typed input and output are never logged or stored.
- A session with no input and no output for 30 minutes is closed (`terminal.IdleTimeout`). Waiting reads do not count as activity.
- The shell is the user's login shell (`SHELL`, falling back to `/bin/zsh`), started as a login shell under the daemon's own OS user with the daemon's environment, plus `TERM=xterm-256color`. Nothing escalates privileges.
- At most 4 running sessions per channel and 16 per computer.

## 9. Resources and relay protection

The following are required before a public launch:

- limits on the number of unauthorized and active connections;
- short lifetimes for challenges, handshakes, and unused channels;
- limits on signal size, signal rate, and queue depth on the relay, and on frame size and queued bytes on the DataChannel;
- a cap on how often credentialed TURN lists are issued, and quotas on the TURN server;
- backpressure or disconnection of a slow receiver instead of accumulating data;
- protection against evicting a registered computer;
- Telegram identity verification and admission rules for public clients;
- limits per source, per device, and on total resource consumption;
- error logging without task content, secrets, or invitations.

Both a relay signal and a DataChannel frame have a 32 KiB upper bound; large results are transferred in parts. The relay keeps a bounded queue per connection and rate-limits signals (120 per second per client, four times that for the computer). The computer limits concurrent peers per device and closes a peer whose DataChannel has more than 256 KiB queued. These are design starting points, not measured capacity; the final values are fixed after backpressure testing and Noise compatibility checks.

The relay is not a cloud queue and not a data path: if the PC is unreachable, or the DataChannel cannot open, a new task is not considered accepted and no later delivery is promised. After the Mini App is closed, the local runtime stores events on the PC rather than streaming continuously into an empty channel.

### 9.1. Free infrastructure

As of the document date, the following terms are officially documented:

| Resource | Terms |
| --- | --- |
| Workers Static Assets | Requests for static files are free; Worker invocations are counted separately |
| Workers Free | 100,000 requests per day |
| Durable Objects Free | 100,000 billable requests and 13,000 GB-seconds per day |
| Inbound WebSocket messages in a DO | Billing applies a ratio of 20 messages to one request |
| Exceeding DO Free quotas | The corresponding operations return errors |

Sources: [S3, S4, S5]. The limits apply to different resources and do not add up to a single quota. The DO free plan uses the SQLite-backed class; this does not require writing application history into its Storage API.

Because application data no longer crosses the relay, Durable Object message billing is driven by signaling alone: a handful of messages per connection setup rather than every task event.

The number of supported users is determined by load testing. It cannot be derived from the number of open sockets alone. Active sessions, message size and rate, object runtime, reconnects, and abuse handling all matter. In the interface, a quota failure must be shown as transport unavailability, not as loss of local history.

## 10. Distribution and updates

The Mini App displays only builds present in a verified release manifest. Each build lists the version, OS, architecture, file name, size, checksum, and signature verification data.

Target build matrix: macOS ARM64/AMD64, Linux ARM64/AMD64, Windows AMD64/ARM64. A platform is declared supported only after testing, including with Codex installed. Successful cross-compilation is not confirmation of full support.

Current state: the daemon targets macOS and Windows (AMD64). The terminal feature is not available on Windows yet; the daemon reports it as "not supported on this platform" and everything else is unchanged. Default data directory per platform: macOS `~/Library/Application Support/Agentik` (unchanged), Windows `%AppData%\Agentik`, other systems `$XDG_CONFIG_HOME/agentik`. On Windows the 0600/0700 file modes are not enforced; identity and database files are protected by the access control list inherited from the per-user `%AppData%` directory. Windows agent discovery looks for `.exe` and `.cmd` on `PATH`, then in `%AppData%\npm` and `%LocalAppData%\Programs`. The Windows binary is built unsigned in CI and published next to the macOS ones.

Self-containment applies to Agentik. The user does not need a Go runtime; the third-party AI agent must be installed separately. Packaging may include a conventional installer around the binary.

Update signing and the signature accepted by the operating system solve different problems. The macOS and Windows procedures for convenient installation are planned separately. A file's SHA-256 is not a substitute for a trusted release signature.

Auto-update does not replace the binary while a task is active. A new version is first downloaded and verified, then installed at a safe moment with the ability to roll back. Signing secrets are not kept in the repository or the client.

## 11. Planned repository structure

| Path | Contents |
| --- | --- |
| `docs/AGENTIK.md` | This document and the accepted architectural decisions |
| `daemon/cmd/agentik` | Entry point of the Go application |
| `daemon/internal/identity` | PC identity and local key storage |
| `daemon/internal/pairing` | Client pairing and revocation |
| `daemon/internal/secure` | Wrapper around the Noise library |
| `daemon/internal/transport` | Relay WSS client: registration, reconnect, limits, and signaling exchange |
| `daemon/internal/webrtc` | Pion peer: offers, DataChannel, DTLS fingerprints, ICE servers, and TURN credentials |
| `daemon/internal/runtime` | Tasks, sessions, approvals, and recovery |
| `daemon/internal/agents/codex` | Codex App Server adapter |
| `daemon/internal/storage` | SQLite and migrations |
| `daemon/internal/projects` | Permitted projects and path validation |
| `miniapp` | React/TypeScript Mini App; `src/webrtc` holds the peer link, fingerprint binding, and feature detection |
| `relay` | Cloudflare Worker and Durable Object |
| `protocol` | Message schemas, versions, and test vectors |
| `scripts` | Build, verification, and release preparation |
| `.github/workflows` | CI and build releases |

This is the target structure, not a list of files that already exist. Dependency versions are pinned during implementation together with a verified compatibility matrix.

## 12. Implementation stages

### Stage 1. Secure connection

A signaling relay with computer registration, the Go client, a minimal Mini App, a WebRTC DataChannel, Noise over it, QR pairing, and local confirmation. No OS commands are run at this stage: the exchange of test data, revocation, and reconnection are what get verified.

Done when: the phone and the PC exchange secure messages; the relay cannot see the payload; a foreign key, a pin substitution, and a replayed invitation are all rejected.

### Stage 2. Local tasks

SQLite, the project model, request IDs, events, states, and the Codex adapter. Launching, responding, approving, cancelling, and resuming a supported session all work end to end, from the Mini App to a real agent.

Done when: closing the phone does not cancel a task; repeating a command does not create a second launch; an ambiguous crash is shown as `recovery_required`.

### Stage 3. Full interface and release

Device, project, session, and result screens; multiple PCs; build selection; installation checks; the supported Telegram/OS matrix; resource limits and diagnostics.

Done when: a new user completes installation and pairing without their own Bot Token or server, and then runs a real task from their phone.

## 13. v0.1 acceptance checks

| Scenario | Expected result |
| --- | --- |
| Installation | The build for the selected platform runs without Go installed |
| Pairing | Access appears only after key verification and confirmation on the PC |
| Unknown phone | Cannot read projects or start tasks |
| Spoofed PC or relay registration | The pin/challenge check rejects the spoof; a running daemon is not evicted |
| Expired invitation | A retry grants no access |
| Forged or stale initData | Telegram identity verification rejects the connection |
| Revocation | Active access ends and a repeat login is rejected |
| Codex missing | A clear error; no false `running` state |
| Real task | The response and events come from the local Codex |
| Approval | A decision applies only to the requested operation; a repeat does not apply to another |
| Repeated task.start | The original task is returned, including when the first response was lost |
| Request ID conflict | Changed content is rejected |
| Closing the Mini App | Work continues on the PC; after reopening, the actual result is available |
| Network change | A new WebRTC connection and Noise handshake restore the previous session |
| Relay restart | Local tasks and history survive; open DataChannels keep working; new connections wait for signaling |
| Daemon crash | State is reconciled; an indeterminate launch is not retried automatically |
| Failure between launch and write | No false guarantee of exactly-once or of success |
| Stop | `cancelled` is shown after a confirmed stop |
| PC offline | The task is not treated as accepted by the cloud |
| Slow client | Queues are bounded, memory does not grow without limit |
| Dangerous agent output | Content is not executed as HTML/JavaScript |
| Secure storage unavailable | No hidden persistence of a long-term secret in localStorage |
| Logs | Prompts, results, signaling payloads, and private keys are absent from server logs |
| New phone | New pairing is required; a Telegram account alone grants no access |
| Swapped DTLS fingerprint on signaling | The Noise handshake fails; no session and no application data |
| Direct path impossible and no TURN | A clear failure with the reason (ICE failed, no candidate pair); no retry through the relay |
| Failed DataChannel | No application frame reaches the relay; the relay carries signaling only |
| WebView without `RTCPeerConnection` | A clear "unsupported" failure; no other transport is tried |
| Relay outage after connecting | The open session continues |
| TURN credentials | Time-limited; the shared secret never leaves the computer |

The checks are run on real Telegram Android/iOS clients and on every declared PC platform. Paths with spaces and Unicode, file permissions, stopping child processes, and restarting the application are verified separately. Controlled fault injection points are used for the crash scenarios.

## 14. Checks still outstanding before release

The architecture is settled; the following are technical verification items for the implementation:

- the specific Noise library, its version, and native/WASM compatibility;
- the final formats of the QR code and the signed structures (the WebRTC Noise prologue is pinned by a cross-language vector);
- WebRTC through real NATs, TURN relaying, and `RTCPeerConnection` behaviour inside the Telegram Android and iOS WebViews;
- Cloudflare reachability from a phone without a VPN, and the Telegram WebView's connection policy for WebRTC and STUN/TURN;
- abuse limits for `ice_servers` credential issuance in a public deployment;
- secure storage availability and WebView behaviour across the Telegram matrix, including WebCrypto Ed25519, without which the Mini App refuses pairing invitations;
- scanning the terminal QR code with real phone cameras from common terminal fonts, colours, and window sizes;
- the supported Codex version and thread recovery after a crash;
- actual sandbox capabilities on each OS;
- limits on active channels, queues, and frames, and overall Free-tier capacity;
- admission rules for the public relay and protection against mass registrations;
- signing, packaging, and safe updating of every published binary.

v0.1 is considered ready once the acceptance scenarios pass on the declared platform matrix. Until then this document is not a security audit or a report on a working system.

## 15. Working with main

Work is done in the existing repository `sergey-telpuk/agentik` and the `main` branch. Before making changes, the repository instructions, the current branch tip, and other people's changes are checked. A commit includes only the files relevant to the task; secrets, local state, and environment-specific settings are not added.

Pushes are ordinary fast-forwards. If main has moved, the new changes are first read and merged without overwriting anyone else's work. Force push is not used. Overriding branch protection rules is not part of the workflow.

## 16. Sources

Public capabilities and pricing were checked on 27 November 2026. Agentik's own design decisions in this document are separate from platform properties and require their own implementation and testing.

- **S1. Telegram Mini Apps:** launching, initData, third-party Ed25519 verification, QR, downloadFile, DeviceStorage, and SecureStorage. <https://core.telegram.org/bots/webapps>
- **S2. Telegram Mini Apps API:** events and platform limitations, including features unavailable on some clients. <https://core.telegram.org/api/bots/webapps>
- **S3. Cloudflare Durable Objects WebSockets:** Hibernation API, connection persistence, and state between activations. <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- **S4. Cloudflare Durable Objects pricing:** free quotas, WebSocket message accounting, and behaviour on exceeding them. <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- **S5. Cloudflare Workers pricing and Static Assets:** <https://developers.cloudflare.com/workers/platform/pricing/>; <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- **S6. Noise Protocol Framework:** the XX handshake, transport encryption, and application responsibilities. <https://noiseprotocol.org/noise.html>
- **S7. Codex App Server:** the local interface, stdio, threads, turns, and events. <https://developers.openai.com/codex/app-server>
- **S8. Pion WebRTC:** the Go WebRTC implementation used by the daemon. <https://github.com/pion/webrtc>
- **S9. RFC 8827, WebRTC Security Architecture:** DTLS-SRTP, certificate fingerprints in signaling, and the role of the signaling channel. <https://www.rfc-editor.org/rfc/rfc8827>
- **S10. RFC 8656, TURN:** relaying through a server for networks without a direct path. <https://www.rfc-editor.org/rfc/rfc8656>
- **S11. coturn:** the `use-auth-secret` time-limited credential scheme. <https://github.com/coturn/coturn>
