/**
 * One attempt to reach one computer: signaling through the relay, a WebRTC
 * DataChannel to the computer, Noise XX over that channel against the pinned
 * key (with both DTLS fingerprints bound into the prologue), pairing state,
 * then a synchronised session ready for commands.
 *
 * The relay is used for signaling only and is closed as soon as the channel
 * is open. There is no fallback: when the channel cannot open the attempt
 * fails with the reason, and no application frame is ever sent to the relay.
 * `failed` and `revoked` are final: retrying means a new attempt. A new
 * signaling epoch while the channel is still opening restarts the
 * negotiation, because a reconnect never resumes anything (AGENTIK.md
 * section 6.1).
 */

import { decodeBase32, decodeBase64Url } from "../../encoding";
import { AgentikRpcClient, RpcError } from "../../protocol/client";
import type { DeviceInfoResult, PairUpdatedEventData } from "../../protocol/messages";
import type { RelayClient, RelayStatus } from "../../relay/client";
import { NoisePinMismatchError, type NoiseKeyPair } from "../../secure/noise";
import type { SecureChannelFactory, SecureSession } from "../../secure/seam";
import { LinkError, type DataLink, type LinkErrorCode } from "../../webrtc/link";
import { webrtcPrologue } from "../../webrtc/prologue";
import { SignalInbox, type Signaling } from "../../webrtc/signaling";
import type { WebRtcSupport } from "../../webrtc/support";
import type { PinnedDevice } from "../../storage/pinnedDevices";
import { readRawInitData, sendInitDataVerification } from "../../telegram/initData";
import type { TelegramRuntime } from "../../telegram/runtime";
import type { ConnectFailure, ConnectionState } from "../types";

/** One-time invitation credentials for `pair.submit`. Memory only, never persisted. */
export interface PendingPairing {
  readonly invitationId: string;
  readonly invitationSecret: string;
  /** Unix seconds after which the computer will refuse the invitation. */
  readonly expiresAt: number;
}

/** What an attempt learned about the computer, for the computer list. */
export type ComputerOutcome = "online" | "offline" | "replaced" | "revoked";

/** Opens the DataChannel to the computer. Rejects with a `LinkError`. */
export type OpenLink = (params: { readonly signaling: Signaling; readonly signal: AbortSignal }) => Promise<DataLink>;

export interface AttemptDeps {
  readonly runtime: TelegramRuntime;
  readonly secureChannel: SecureChannelFactory;
  /** The signaling connection. It carries SDP and ICE, never application data. */
  readonly createRelayClient: (device: PinnedDevice) => RelayClient;
  readonly openLink: OpenLink;
  /** Whether this WebView can open a DataChannel at all. */
  readonly webRtcSupport: () => WebRtcSupport;
  readonly loadIdentity: () => Promise<{ ok: true; value: NoiseKeyPair } | { ok: false; message: string }>;
  readonly findPin: (computerId: string) => Promise<PinnedDevice | null>;
  readonly markConfirmed: (computerId: string) => Promise<void>;
  readonly peekPendingPairing: (computerId: string) => PendingPairing | null;
  readonly dropPendingPairing: (computerId: string) => void;
  readonly computerName: (computerId: string) => string;
  readonly recordOutcome: (computerId: string, outcome: ComputerOutcome) => void;
  readonly onReady: (computerId: string, rpc: AgentikRpcClient) => void;
  readonly now: () => number;
  readonly rpcTimeoutMs: number;
  readonly offlineGraceMs: number;
  readonly maxRelayAttempts: number;
}

export class ConnectAttempt {
  readonly computerId: string;
  readonly #deps: AttemptDeps;
  readonly #onState: (state: ConnectionState) => void;
  #state: ConnectionState = { phase: "connecting" };
  #closed = false;
  #final = false;
  #relay: RelayClient | null = null;
  #offStatus: (() => void) | null = null;
  #offSignal: (() => void) | null = null;
  #inbox = new SignalInbox();
  #link: DataLink | null = null;
  #offLinkClosed: (() => void) | null = null;
  #offlineTimer: ReturnType<typeof setTimeout> | null = null;
  #handledEpoch = 0;
  #device: PinnedDevice | null = null;
  #identity: NoiseKeyPair | null = null;
  /** Bumped for every handshake so late results of an older one are ignored. */
  #generation = 0;
  #abort: AbortController | null = null;
  #session: SecureSession | null = null;
  #candidate: AgentikRpcClient | null = null;
  #offEvent: (() => void) | null = null;
  #verificationCode: string | undefined;
  /** The RPC client of the current synchronised session, or null. */
  rpc: AgentikRpcClient | null = null;

  constructor(computerId: string, deps: AttemptDeps, onState: (state: ConnectionState) => void) {
    this.computerId = computerId;
    this.#deps = deps;
    this.#onState = onState;
  }

  get revoked(): boolean {
    return this.#state.phase === "revoked";
  }

  start(): void {
    this.#emit({ phase: "connecting" }, true);
    void this.#prepare();
  }

  /** Stops everything. Safe to call more than once. */
  close(): void {
    this.#closed = true;
    this.#teardown();
  }

  async #prepare(): Promise<void> {
    const device = await this.#deps.findPin(this.computerId);
    if (this.#closed) return;
    if (device === null) {
      this.#fail("handshake_failed", "This computer is not paired on this phone.", false);
      return;
    }
    if (decodeBase32(device.deviceId) === null || decodeBase64Url(device.noisePublicKey) === null) {
      this.#fail("handshake_failed", "The key pinned for this computer is not valid. Pair it again.", false);
      return;
    }
    const identity = await this.#deps.loadIdentity();
    if (this.#closed) return;
    if (!identity.ok) {
      this.#fail("handshake_failed", `This phone cannot load its own key: ${identity.message}.`, false);
      return;
    }
    this.#device = device;
    this.#identity = identity.value;

    // No RTCPeerConnection means no data path at all. Say so; the relay is
    // never contacted and nothing else is tried.
    const support = this.#deps.webRtcSupport();
    if (!support.supported) {
      this.#fail(
        "webrtc_unsupported",
        `This phone cannot connect to a computer: ${support.reason}. Agentik sends all data over WebRTC and has no other path.`,
        false,
      );
      return;
    }

    let relay: RelayClient;
    try {
      relay = this.#deps.createRelayClient(device);
    } catch (err) {
      this.#fail("relay_unreachable", `The relay connection could not be created: ${messageOf(err)}.`, false);
      return;
    }
    this.#relay = relay;
    // Subscribe before the socket opens: the computer's ice_servers arrive
    // right behind the relay's `attached`.
    this.#offSignal = relay.onSignal((kind, data) => this.#inbox.push(kind, data));
    this.#offStatus = relay.onStatus((status) => this.#onRelayStatus(status));
    relay.start();
  }

  #onRelayStatus(status: RelayStatus): void {
    if (this.#closed || this.#final) return;
    switch (status.state) {
      case "failed":
        this.#fail(
          "relay_unreachable",
          `The relay refused this phone (${status.lastError ?? "unknown error"}). Retrying will not help until the app is updated.`,
          false,
        );
        return;
      case "reconnecting":
        this.#dropSession();
        if (status.attempt >= this.#deps.maxRelayAttempts) {
          this.#fail("relay_unreachable", "The relay cannot be reached. Check the network and try again.", true);
          return;
        }
        this.#emit({ phase: "connecting" });
        return;
      case "connecting":
      case "stopped":
        return;
      case "connected":
        if (status.devicePresent !== true) {
          this.#dropSession();
          this.#emit({ phase: "connecting" });
          this.#startOfflineTimer();
          return;
        }
        this.#clearOfflineTimer();
        if (status.peerEpoch !== this.#handledEpoch) {
          this.#handledEpoch = status.peerEpoch;
          this.#dropSession();
          // Signals from an earlier negotiation belong to a dead peer.
          this.#inbox.reset();
          void this.#establish();
        }
        return;
    }
  }

  #startOfflineTimer(): void {
    if (this.#offlineTimer !== null) return;
    this.#offlineTimer = setTimeout(() => {
      this.#offlineTimer = null;
      if (this.#closed || this.#final) return;
      this.#deps.recordOutcome(this.computerId, "offline");
      this.#fail(
        "computer_offline",
        `The relay is reachable, but ${this.#deps.computerName(this.computerId)} is not connected. It may be asleep or offline. Tasks already running there keep running.`,
        true,
      );
    }, this.#deps.offlineGraceMs);
  }

  #clearOfflineTimer(): void {
    if (this.#offlineTimer !== null) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = null;
  }

  /** Opens the DataChannel, then runs the Noise handshake over it. */
  async #establish(): Promise<void> {
    const relay = this.#relay;
    const device = this.#device;
    const identity = this.#identity;
    if (relay === null || device === null || identity === null) return;
    const deviceId = decodeBase32(device.deviceId);
    const pinned = decodeBase64Url(device.noisePublicKey);
    if (deviceId === null || pinned === null) return;

    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    const current = (): boolean => !this.#closed && !this.#final && generation === this.#generation;

    const signaling: Signaling = {
      send: (kind, data) => relay.sendSignal(kind, data),
      onSignal: (handler) => this.#inbox.subscribe(handler),
    };
    let link: DataLink;
    try {
      link = await this.#deps.openLink({ signaling, signal: abort.signal });
    } catch (err) {
      if (!current()) return;
      const code: LinkErrorCode = err instanceof LinkError ? err.code : "signaling";
      this.#fail(linkFailure(code), `Could not open the data channel to ${this.#deps.computerName(this.computerId)}: ${messageOf(err)}`, code !== "unsupported");
      return;
    }
    if (!current()) {
      link.close();
      return;
    }
    // The channel is up: signaling has done its job and the relay is released.
    this.#link = link;
    this.#offLinkClosed = link.onClosed((reason) => {
      if (!current()) return;
      this.#fail("link_lost", `The data channel to ${this.#deps.computerName(this.computerId)} closed (${reason}). Tasks already running there keep running.`, true);
    });
    this.#releaseRelay();

    let prologue: Uint8Array;
    try {
      prologue = webrtcPrologue(deviceId, link.localFingerprint, link.remoteFingerprint);
    } catch (err) {
      this.#fail("handshake_failed", `The connection fingerprints are unusable (${messageOf(err)}).`, true);
      return;
    }
    this.#emit({ phase: "handshaking" });

    let session: SecureSession;
    try {
      session = await this.#deps.secureChannel.open({
        transport: link.transport,
        prologue,
        pinnedNoisePublicKey: pinned,
        clientStaticPrivateKey: identity.privateKey,
        signal: abort.signal,
      });
    } catch (err) {
      if (!current()) return;
      if (err instanceof NoisePinMismatchError) {
        this.#deps.recordOutcome(this.computerId, "replaced");
        this.#fail(
          "key_mismatch",
          "The computer presented a different key from the one pinned on this phone. It may have been reinstalled, or something is impersonating it. Pair it again on the computer to continue.",
          false,
        );
        return;
      }
      this.#fail(
        "handshake_failed",
        `The secure handshake did not complete (${messageOf(err)}). Nothing was sent to the computer. If this repeats, the connection may have been tampered with: the handshake fails when the DTLS fingerprints the two sides saw differ.`,
        true,
      );
      return;
    }
    if (!current()) {
      session.close();
      return;
    }

    this.#session = session;
    const rpc = new AgentikRpcClient(session, { timeoutMs: this.#deps.rpcTimeoutMs });
    this.#candidate = rpc;
    this.#offEvent = rpc.onEvent((ev) => {
      if (ev.event === "pair.updated" && current()) void this.#onPairUpdated(ev.data, rpc, current);
    });

    // The raw initData goes to the computer only inside the Noise session;
    // the computer verifies it. Nothing here trusts its contents.
    const initData = readRawInitData(this.#deps.runtime);
    if (initData.ok) sendInitDataVerification(session, initData.rawInitData);

    let info: DeviceInfoResult;
    try {
      info = await rpc.deviceInfo();
    } catch (err) {
      if (!current()) return;
      this.#fail("handshake_failed", `The computer did not answer after the handshake (${messageOf(err)}).`, true);
      return;
    }
    if (!current()) return;

    switch (info.pairing_state) {
      case "paired":
        this.#deps.dropPendingPairing(this.computerId);
        await this.#synchronize(rpc, current);
        return;
      case "awaiting_local_approval":
        this.#emitAwaiting();
        return;
      case "revoked":
        this.#revoke("The computer revoked access for this phone.");
        return;
      case "unpaired":
        await this.#submitPairing(rpc, initData.ok ? initData.rawInitData : null, current);
        return;
    }
  }

  async #submitPairing(rpc: AgentikRpcClient, initData: string | null, current: () => boolean): Promise<void> {
    const pending = this.#deps.peekPendingPairing(this.computerId);
    if (pending === null) {
      this.#fail(
        "not_paired",
        "This phone is not paired with the computer. Create a fresh invitation on the computer and pair again.",
        false,
      );
      return;
    }
    if (pending.expiresAt * 1000 <= this.#deps.now()) {
      this.#deps.dropPendingPairing(this.computerId);
      this.#fail("not_paired", "The invitation expired before the computer was reached. Create a fresh one on the computer.", false);
      return;
    }
    try {
      const result = await rpc.submitPairing({
        invitation_id: pending.invitationId,
        invitation_secret: pending.invitationSecret,
        ...(initData === null ? {} : { init_data: initData }),
      });
      if (!current()) return;
      // The invitation is single-use: whatever the computer answered, it is spent.
      this.#deps.dropPendingPairing(this.computerId);
      if (result.state === "paired") {
        await this.#synchronize(rpc, current);
        return;
      }
      this.#verificationCode = result.verification_code;
      this.#emitAwaiting();
    } catch (err) {
      if (!current()) return;
      if (err instanceof RpcError) {
        this.#deps.dropPendingPairing(this.computerId);
        this.#fail("not_paired", `The computer refused the pairing (${err.message}). Create a fresh invitation and pair again.`, false);
        return;
      }
      this.#fail("handshake_failed", `The pairing request got no answer (${messageOf(err)}).`, true);
    }
  }

  async #onPairUpdated(data: PairUpdatedEventData, rpc: AgentikRpcClient, current: () => boolean): Promise<void> {
    if (data.device_id !== this.computerId) return;
    this.#deps.dropPendingPairing(this.computerId);
    switch (data.state) {
      case "paired":
        if (this.rpc === null) await this.#synchronize(rpc, current);
        return;
      case "revoked":
        this.#revoke("The computer revoked access for this phone.");
        return;
      case "rejected":
      case "expired":
        this.#fail(
          "not_paired",
          `Pairing ${data.state} by the computer. Create a fresh invitation on the computer and pair again.`,
          false,
        );
        return;
    }
  }

  async #synchronize(rpc: AgentikRpcClient, current: () => boolean): Promise<void> {
    this.#emit({ phase: "synchronizing" });
    await this.#deps.markConfirmed(this.computerId);
    if (!current()) return;
    try {
      // The first paired-only command proves this session is authorised.
      await rpc.listProjects();
    } catch (err) {
      if (!current()) return;
      if (err instanceof RpcError && err.code === "unauthorized") {
        this.#revoke("The computer no longer accepts this phone.");
        return;
      }
      this.#fail("handshake_failed", `Synchronising with the computer failed (${messageOf(err)}).`, true);
      return;
    }
    if (!current()) return;
    this.rpc = rpc;
    this.#deps.recordOutcome(this.computerId, "online");
    this.#emit({ phase: "ready", computerName: this.#deps.computerName(this.computerId) });
    this.#deps.onReady(this.computerId, rpc);
  }

  #emitAwaiting(): void {
    this.#emit(
      this.#verificationCode === undefined
        ? { phase: "awaiting_local_approval" }
        : { phase: "awaiting_local_approval", verificationCode: this.#verificationCode },
      true,
    );
  }

  #revoke(message: string): void {
    this.#deps.recordOutcome(this.computerId, "revoked");
    this.#emit({ phase: "revoked", message }, true);
    this.#final = true;
    this.#teardown();
  }

  #fail(reason: ConnectFailure, message: string, retryable: boolean): void {
    this.#emit({ phase: "failed", reason, message, retryable }, true);
    this.#final = true;
    this.#teardown();
  }

  /** Forgets the current link and secure session; the relay is not touched. */
  #dropSession(): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#offLinkClosed?.();
    this.#offLinkClosed = null;
    this.#link?.close();
    this.#link = null;
    this.#offEvent?.();
    this.#offEvent = null;
    this.#candidate?.close();
    this.#candidate = null;
    this.rpc = null;
    this.#session?.close();
    this.#session = null;
  }

  #teardown(): void {
    this.#clearOfflineTimer();
    this.#dropSession();
    this.#releaseRelay();
  }

  /** Stops signaling: after the channel opened (or the attempt ended) the relay is not needed. */
  #releaseRelay(): void {
    this.#offStatus?.();
    this.#offStatus = null;
    this.#offSignal?.();
    this.#offSignal = null;
    this.#relay?.stop();
    this.#relay = null;
  }

  #emit(state: ConnectionState, force = false): void {
    if (this.#closed || this.#final) return;
    if (!force && state.phase === this.#state.phase) return;
    this.#state = state;
    this.#onState(state);
  }
}

function linkFailure(code: LinkErrorCode): ConnectFailure {
  switch (code) {
    case "unsupported":
      return "webrtc_unsupported";
    case "ice_failed":
    case "timeout":
      return "ice_failed";
    case "closed":
      return "link_lost";
    case "signaling":
      return "relay_unreachable";
    case "protocol":
      return "handshake_failed";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
