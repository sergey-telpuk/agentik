declare module "@richardhopton/noise-c.wasm" {
  export interface NoiseConstants {
    readonly NOISE_DH_CURVE25519: number;
    readonly NOISE_ROLE_INITIATOR: number;
    readonly NOISE_ROLE_RESPONDER: number;
    readonly NOISE_ACTION_NONE: number;
    readonly NOISE_ACTION_WRITE_MESSAGE: number;
    readonly NOISE_ACTION_READ_MESSAGE: number;
    readonly NOISE_ACTION_FAILED: number;
    readonly NOISE_ACTION_SPLIT: number;
  }

  export interface NoiseCipherState {
    EncryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
    DecryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
    free(): void;
  }

  export interface NoiseHandshakeState {
    Initialize(
      prologue: Uint8Array | null,
      s: Uint8Array | null,
      rs: Uint8Array | null,
      psk: Uint8Array | null,
    ): void;
    GetAction(): number;
    WriteMessage(payload?: Uint8Array | null): Uint8Array;
    ReadMessage(
      message: Uint8Array,
      payloadNeeded?: boolean,
      fallbackSupported?: boolean,
    ): Uint8Array | null;
    GetRemotePublicKey(): Uint8Array | null;
    Split(): [NoiseCipherState, NoiseCipherState];
    free(): void;
  }

  export interface NoiseRuntime {
    readonly constants: NoiseConstants;
    CreateKeyPair(curveId: number): [Uint8Array, Uint8Array];
    HandshakeState: new (protocolName: string, role: number) => NoiseHandshakeState;
    CipherState: new (cipher: number) => NoiseCipherState;
    readonly _lib_internal: {
      _random_bytes: (size: number) => Uint8Array;
    };
  }

  export interface NoiseModuleOptions {
    locateFile?: (path: string, scriptDirectory: string) => string;
    wasmBinary?: Uint8Array;
  }

  export default function createNoise(
    options: NoiseModuleOptions | ((noise: NoiseRuntime) => void),
    callback?: (noise: NoiseRuntime) => void,
  ): void;
}

declare module "@richardhopton/noise-c.wasm/src/noise-c.wasm?url" {
  const wasmUrl: string;
  export default wasmUrl;
}
