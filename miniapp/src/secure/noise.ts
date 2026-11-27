/**
 * Real Noise_XX_25519_ChaChaPoly_SHA256 initiator built on the pinned
 * `@richardhopton/noise-c.wasm` (rweather/noise-c compiled to WASM).
 *
 * Matches the Go daemon's `daemon/internal/secure`. The handshake runs over
 * the WebRTC DataChannel and its prologue is supplied by the caller: in
 * production `webrtcPrologue` (`src/webrtc/prologue.ts`), which binds both DTLS
 * fingerprints so a swapped fingerprint makes the handshake fail. No commands or early
 * payloads are ever exchanged during the handshake; the daemon's static X25519
 * public key is verified against the pinned key immediately after handshake
 * message 2 before message 3 is written.
 */

import createNoise, {
  type NoiseCipherState,
  type NoiseHandshakeState,
  type NoiseModuleOptions,
  type NoiseRuntime,
} from "@richardhopton/noise-c.wasm";
import wasmUrl from "@richardhopton/noise-c.wasm/src/noise-c.wasm?url";
import { bytesEqual } from "../encoding";
import { MAX_FRAME_BYTES, type FrameTransport } from "../relay/frame-transport";
import type { SecureChannelFactory, SecureChannelParams, SecureSession } from "./seam";

export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";
export const NOISE_PROLOGUE_CONTEXT = "agentik-noise-prologue-v1";
export const NOISE_PROTOCOL_VERSION = 1;
export const NOISE_ROLE_INITIATOR = "client";
export const NOISE_ROLE_RESPONDER = "device";
export const NOISE_KEY_SIZE = 32;
export const NOISE_MAC_SIZE = 16;
export const MAX_PLAINTEXT_SIZE = MAX_FRAME_BYTES - NOISE_MAC_SIZE;
export const DEFAULT_NOISE_HANDSHAKE_TIMEOUT_MS = 15_000;

const EMPTY_AD = new Uint8Array(0);

export class NoisePinMismatchError extends Error {
  constructor() {
    super("Computer static key does not match the pinned key");
    this.name = "NoisePinMismatchError";
  }
}

export class NoiseHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseHandshakeError";
  }
}

export class NoiseSessionClosedError extends Error {
  constructor() {
    super("The Noise secure session is closed");
    this.name = "NoiseSessionClosedError";
  }
}

export class NoisePayloadTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Plaintext payload of ${size} bytes exceeds limit of ${limit} bytes`);
    this.name = "NoisePayloadTooLargeError";
  }
}

export interface NoiseKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/**
 * The legacy prologue without fingerprints, matching `protocol.NoisePrologue`.
 * It is not used on any connection; it stays so the cross-language Noise
 * vector (`daemon/internal/secure/vector_test.go`) keeps proving that the
 * handshake bytes match. Connections use `webrtcPrologue`.
 */
export function devicePrologue(deviceId: Uint8Array): Uint8Array {
  if (deviceId.length !== 32) {
    throw new Error(`deviceId must be 32 bytes, got ${deviceId.length}`);
  }
  const encoder = new TextEncoder();
  const context = encoder.encode(NOISE_PROLOGUE_CONTEXT);
  const client = encoder.encode(NOISE_ROLE_INITIATOR);
  const device = encoder.encode(NOISE_ROLE_RESPONDER);

  const totalLength =
    4 + context.length + 2 + 4 + client.length + 4 + device.length + 4 + deviceId.length;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;

  const writeBytes = (bytes: Uint8Array): void => {
    view.setUint32(offset, bytes.length, false);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.length;
  };

  writeBytes(context);
  view.setUint16(offset, NOISE_PROTOCOL_VERSION, false);
  offset += 2;
  writeBytes(client);
  writeBytes(device);
  writeBytes(deviceId);

  return out;
}

let cachedRuntimePromise: Promise<NoiseRuntime> | null = null;

function defaultModuleOptions(): NoiseModuleOptions {
  const isNode =
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
    "string";
  if (isNode) return {};
  return {
    locateFile: (path: string) => (path.endsWith(".wasm") ? wasmUrl : path),
  };
}

/** Loads the shared `noise-c.wasm` runtime once. */
export function loadNoiseRuntime(): Promise<NoiseRuntime> {
  if (cachedRuntimePromise === null) {
    cachedRuntimePromise = loadFreshNoiseRuntime();
  }
  return cachedRuntimePromise;
}

/** Instantiates a fresh `noise-c.wasm` runtime (used in deterministic tests). */
export function loadFreshNoiseRuntime(options?: NoiseModuleOptions): Promise<NoiseRuntime> {
  const resolved = options ?? defaultModuleOptions();
  return new Promise<NoiseRuntime>((resolve, reject) => {
    try {
      createNoise(resolved, (runtime) => resolve(runtime));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Generates a fresh X25519 keypair using `noise-c.wasm`. */
export async function generateNoiseKeyPair(runtime?: NoiseRuntime): Promise<NoiseKeyPair> {
  const noise = runtime ?? (await loadNoiseRuntime());
  const [privateKey, publicKey] = noise.CreateKeyPair(noise.constants.NOISE_DH_CURVE25519);
  return { privateKey, publicKey };
}

class NoiseSecureSession implements SecureSession {
  readonly #transport: FrameTransport;
  readonly #sendCipher: NoiseCipherState;
  readonly #recvCipher: NoiseCipherState;
  readonly #messageHandlers = new Set<(plaintext: Uint8Array) => void>();
  readonly #errorHandlers = new Set<(error: Error) => void>();
  readonly #offFrame: () => void;
  #closed = false;

  constructor(
    transport: FrameTransport,
    sendCipher: NoiseCipherState,
    recvCipher: NoiseCipherState,
  ) {
    this.#transport = transport;
    this.#sendCipher = sendCipher;
    this.#recvCipher = recvCipher;
    this.#offFrame = this.#transport.onFrame((frame) => {
      if (this.#closed) return;
      let plaintext: Uint8Array;
      try {
        plaintext = this.#recvCipher.DecryptWithAd(EMPTY_AD, frame);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const handler of this.#errorHandlers) handler(error);
        return;
      }
      for (const handler of this.#messageHandlers) handler(plaintext);
    });
  }

  send(plaintext: Uint8Array): void {
    if (this.#closed) throw new NoiseSessionClosedError();
    if (plaintext.length > MAX_PLAINTEXT_SIZE) {
      throw new NoisePayloadTooLargeError(plaintext.length, MAX_PLAINTEXT_SIZE);
    }
    const ciphertext = this.#sendCipher.EncryptWithAd(EMPTY_AD, plaintext);
    try {
      this.#transport.sendFrame(ciphertext);
    } catch (err) {
      // Transport send failure invalidates the session rather than risking nonce desync.
      this.close();
      throw err;
    }
  }

  onMessage(handler: (plaintext: Uint8Array) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offFrame();
    this.#messageHandlers.clear();
    this.#errorHandlers.clear();
    try {
      this.#sendCipher.free();
    } catch {
      // Already freed.
    }
    try {
      this.#recvCipher.free();
    } catch {
      // Already freed.
    }
  }
}

export interface NoiseChannelFactoryOptions {
  readonly getRuntime?: () => Promise<NoiseRuntime>;
}

export function createNoiseChannelFactory(
  factoryOptions: NoiseChannelFactoryOptions = {},
): SecureChannelFactory {
  const getRuntime = factoryOptions.getRuntime ?? loadNoiseRuntime;

  return {
    async open(params: SecureChannelParams): Promise<SecureSession> {
      if (params.prologue.length === 0) {
        throw new NoiseHandshakeError("a prologue binding the connection is required");
      }
      if (params.pinnedNoisePublicKey.length !== NOISE_KEY_SIZE) {
        throw new NoiseHandshakeError("pinnedNoisePublicKey must be 32 bytes");
      }
      if (params.clientStaticPrivateKey.length !== NOISE_KEY_SIZE) {
        throw new NoiseHandshakeError("clientStaticPrivateKey must be 32 bytes");
      }
      if (params.signal?.aborted) {
        throw new NoiseHandshakeError("Noise handshake aborted");
      }

      const noise = await getRuntime();
      if (params.signal?.aborted) {
        throw new NoiseHandshakeError("Noise handshake aborted");
      }

      const prologue = params.prologue;
      const hs: NoiseHandshakeState = new noise.HandshakeState(
        NOISE_PROTOCOL_NAME,
        noise.constants.NOISE_ROLE_INITIATOR,
      );
      let hsAlive = true;

      const freeHandshake = (): void => {
        if (!hsAlive) return;
        hsAlive = false;
        try {
          hs.free();
        } catch {
          // noise-c.wasm frees the state automatically on internal errors.
        }
      };

      try {
        hs.Initialize(prologue, params.clientStaticPrivateKey, null, null);
      } catch (err) {
        hsAlive = false;
        throw new NoiseHandshakeError(
          `handshake initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return new Promise<SecureSession>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let offFrame: (() => void) | null = null;

        const cleanup = (): void => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (offFrame !== null) {
            offFrame();
            offFrame = null;
          }
          params.signal?.removeEventListener("abort", onAbort);
        };

        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          freeHandshake();
          reject(err);
        };

        const onAbort = (): void => {
          fail(new NoiseHandshakeError("Noise handshake aborted"));
        };
        params.signal?.addEventListener("abort", onAbort, { once: true });

        const timeoutMs = params.handshakeTimeoutMs ?? DEFAULT_NOISE_HANDSHAKE_TIMEOUT_MS;
        timer = setTimeout(() => {
          fail(new NoiseHandshakeError("Noise handshake timed out"));
        }, timeoutMs);

        offFrame = params.transport.onFrame((msg2) => {
          if (settled) return;
          try {
            if (hs.GetAction() !== noise.constants.NOISE_ACTION_READ_MESSAGE) {
              fail(new NoiseHandshakeError("unexpected handshake state"));
              return;
            }
            // ReadMessage auto-frees `hs` if it throws.
            try {
              hs.ReadMessage(msg2, false, false);
            } catch (err) {
              hsAlive = false;
              throw new NoiseHandshakeError(
                `handshake message 2 rejected: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

            const remoteStatic = hs.GetRemotePublicKey();
            if (remoteStatic === null || !bytesEqual(remoteStatic, params.pinnedNoisePublicKey)) {
              fail(new NoisePinMismatchError());
              return;
            }

            if (hs.GetAction() !== noise.constants.NOISE_ACTION_WRITE_MESSAGE) {
              fail(new NoiseHandshakeError("unexpected handshake state after message 2"));
              return;
            }

            let msg3: Uint8Array;
            try {
              msg3 = hs.WriteMessage(null);
            } catch (err) {
              hsAlive = false;
              throw new NoiseHandshakeError(
                `handshake message 3 failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

            if (hs.GetAction() !== noise.constants.NOISE_ACTION_SPLIT) {
              fail(new NoiseHandshakeError("handshake did not reach split state"));
              return;
            }

            let sendCipher: NoiseCipherState;
            let recvCipher: NoiseCipherState;
            try {
              [sendCipher, recvCipher] = hs.Split();
              hsAlive = false;
            } catch (err) {
              hsAlive = false;
              throw new NoiseHandshakeError(
                `handshake split failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

            // Send msg3 before exposing the session. If transport fails, free the
            // derived cipher states rather than leaking WASM memory.
            try {
              params.transport.sendFrame(msg3);
            } catch (err) {
              try {
                sendCipher.free();
              } catch {
                // ignore
              }
              try {
                recvCipher.free();
              } catch {
                // ignore
              }
              throw err instanceof Error ? err : new Error(String(err));
            }

            settled = true;
            cleanup();
            resolve(new NoiseSecureSession(params.transport, sendCipher, recvCipher));
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });

        try {
          if (hs.GetAction() !== noise.constants.NOISE_ACTION_WRITE_MESSAGE) {
            fail(new NoiseHandshakeError("initiator not in write state"));
            return;
          }
          let msg1: Uint8Array;
          try {
            msg1 = hs.WriteMessage(null);
          } catch (err) {
            hsAlive = false;
            throw new NoiseHandshakeError(
              `handshake message 1 failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          params.transport.sendFrame(msg1);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}

export const noiseChannelFactory: SecureChannelFactory = createNoiseChannelFactory();
