import type { NoiseCipherState } from "@richardhopton/noise-c.wasm";
import { describe, expect, it } from "vitest";
import type { FrameTransport } from "../relay/frame-transport";
import {
  createNoiseChannelFactory,
  devicePrologue,
  generateNoiseKeyPair,
  loadFreshNoiseRuntime,
  MAX_RELAY_PLAINTEXT_SIZE,
  NOISE_PROTOCOL_NAME,
  NoiseHandshakeError,
  NoisePayloadTooLargeError,
  NoisePinMismatchError,
  NoiseSessionClosedError,
} from "./noise";

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exact deterministic test vector generated from Go's `github.com/flynn/noise`
 * in `daemon/internal/secure/vector_test.go`. Proves byte-for-byte
 * compatibility across Go (`flynn/noise`) and TypeScript/WASM (`noise-c.wasm`).
 */
const GO_VECTOR = {
  deviceIdHex: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
  prologueHex:
    "000000196167656e74696b2d6e6f6973652d70726f6c6f6775652d7631000100000006636c69656e74000000066465766963650000002056475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
  initStaticPriv: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e4f",
  initStaticPub: "92ae943cc4f29c0a6b83222eb0c3024206809d15f7b78274f0d28211981ddf15",
  respStaticPriv: "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e6f",
  respStaticPub: "5a5ceba4043f071dd664133c0120ad7e86ad55f430735449110238330ab00810",
  initEphPriv: "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbe4f",
  respEphPriv: "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcddde6f",
  msg1Hex: "a0ccb3b25341f032cc587460b0ef7bd5465301492ae3606a2addaa58777a586b",
  msg2Hex:
    "3676fee442ab4be2f21a20f690e898b95951e6748c164046631a733618eb6c47b50f79d702d8832657144d6d74091cc44d1fdb46ac9300582b273f446eef5a64aa64f42c350d6f480ec96704e882fbb9984c8268fe3bd85525e493bd1994d77c",
  msg3Hex:
    "845dc94cf29b22c4963616688442bdea96726829e43af8d88665ff81c588ac42768ef85c7878d8d63591387ff3059688a689d4d2a2feb049e6637f81abb61d01",
  c2dPlaintextHex: "7b2276223a312c226d6574686f64223a226465766963652e696e666f227d",
  c2dCiphertextHex: "8be4565790c1599d4ae87a50c255f17628956200bd021fbf1b85b041b68fef00ca028c302f72e48e7a0f83d128b3",
  d2cPlaintextHex: "7b226f6b223a747275657d",
  d2cCiphertextHex: "32480a0144e40c3f0b5189b2d8cac585b8ea91144f22c221a5832d",
};

function createLinkedTransports(): {
  client: FrameTransport;
  daemon: FrameTransport;
  clientSent: Uint8Array[];
} {
  const clientHandlers = new Set<(frame: Uint8Array) => void>();
  const daemonHandlers = new Set<(frame: Uint8Array) => void>();
  const clientSent: Uint8Array[] = [];

  const client: FrameTransport = {
    sendFrame(frame) {
      const copy = frame.slice();
      clientSent.push(copy);
      queueMicrotask(() => {
        for (const h of daemonHandlers) h(copy.slice());
      });
    },
    onFrame(handler) {
      clientHandlers.add(handler);
      return () => clientHandlers.delete(handler);
    },
  };

  const daemon: FrameTransport = {
    sendFrame(frame) {
      const copy = frame.slice();
      queueMicrotask(() => {
        for (const h of clientHandlers) h(copy.slice());
      });
    },
    onFrame(handler) {
      daemonHandlers.add(handler);
      return () => daemonHandlers.delete(handler);
    },
  };

  return { client, daemon, clientSent };
}

describe("Noise_XX_25519_ChaChaPoly_SHA256 cross-language test vector", () => {
  it("matches Go flynn/noise byte-for-byte across prologue, handshake, and transport", async () => {
    const deviceId = hexToBytes(GO_VECTOR.deviceIdHex);
    expect(bytesToHex(devicePrologue(deviceId))).toBe(GO_VECTOR.prologueHex);

    const initNoise = await loadFreshNoiseRuntime();
    const respNoise = await loadFreshNoiseRuntime();

    initNoise._lib_internal._random_bytes = () => hexToBytes(GO_VECTOR.initEphPriv);
    respNoise._lib_internal._random_bytes = () => hexToBytes(GO_VECTOR.respEphPriv);

    const initiator = new initNoise.HandshakeState(
      NOISE_PROTOCOL_NAME,
      initNoise.constants.NOISE_ROLE_INITIATOR,
    );
    const responder = new respNoise.HandshakeState(
      NOISE_PROTOCOL_NAME,
      respNoise.constants.NOISE_ROLE_RESPONDER,
    );

    const prologue = devicePrologue(deviceId);
    initiator.Initialize(prologue, hexToBytes(GO_VECTOR.initStaticPriv), null, null);
    responder.Initialize(prologue, hexToBytes(GO_VECTOR.respStaticPriv), null, null);

    const msg1 = initiator.WriteMessage(null);
    expect(bytesToHex(msg1)).toBe(GO_VECTOR.msg1Hex);
    responder.ReadMessage(msg1, false, false);

    const msg2 = responder.WriteMessage(null);
    expect(bytesToHex(msg2)).toBe(GO_VECTOR.msg2Hex);
    initiator.ReadMessage(msg2, false, false);
    expect(bytesToHex(initiator.GetRemotePublicKey() ?? new Uint8Array())).toBe(
      GO_VECTOR.respStaticPub,
    );

    const msg3 = initiator.WriteMessage(null);
    expect(bytesToHex(msg3)).toBe(GO_VECTOR.msg3Hex);
    responder.ReadMessage(msg3, false, false);
    expect(bytesToHex(responder.GetRemotePublicKey() ?? new Uint8Array())).toBe(
      GO_VECTOR.initStaticPub,
    );

    const [initSend, initRecv] = initiator.Split();
    const [respSend, respRecv] = responder.Split();

    const emptyAd = new Uint8Array(0);
    const c2dCT = initSend.EncryptWithAd(emptyAd, hexToBytes(GO_VECTOR.c2dPlaintextHex));
    expect(bytesToHex(c2dCT)).toBe(GO_VECTOR.c2dCiphertextHex);
    const c2dPT = respRecv.DecryptWithAd(emptyAd, c2dCT);
    expect(bytesToHex(c2dPT)).toBe(GO_VECTOR.c2dPlaintextHex);

    const d2cCT = respSend.EncryptWithAd(emptyAd, hexToBytes(GO_VECTOR.d2cPlaintextHex));
    expect(bytesToHex(d2cCT)).toBe(GO_VECTOR.d2cCiphertextHex);
    const d2cPT = initRecv.DecryptWithAd(emptyAd, d2cCT);
    expect(bytesToHex(d2cPT)).toBe(GO_VECTOR.d2cPlaintextHex);

    initSend.free();
    initRecv.free();
    respSend.free();
    respRecv.free();
  });
});

describe("NoiseChannelFactory", () => {
  async function startResponder(
    daemonTransport: FrameTransport,
    deviceId: Uint8Array,
    respPriv: Uint8Array,
    onReady: (send: { s: NoiseCipherState; r: NoiseCipherState }, rawRecv: (frame: Uint8Array) => void) => void,
  ): Promise<{
    getClientStatic: () => Uint8Array | null;
    sendEncrypted: (pt: Uint8Array) => void;
    sendRaw: (ct: Uint8Array) => void;
  }> {
    const noise = await loadFreshNoiseRuntime();
    const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
    hs.Initialize(devicePrologue(deviceId), respPriv, null, null);
    let step = 1;
    let sendCipher: NoiseCipherState | null = null;
    let recvCipher: NoiseCipherState | null = null;
    let clientStatic: Uint8Array | null = null;
    const emptyAd = new Uint8Array(0);

    daemonTransport.onFrame((frame) => {
      if (step === 1) {
        hs.ReadMessage(frame, false, false);
        const msg2 = hs.WriteMessage(null);
        step = 3;
        daemonTransport.sendFrame(msg2);
        return;
      }
      if (step === 3) {
        hs.ReadMessage(frame, false, false);
        clientStatic = hs.GetRemotePublicKey();
        const [s, r] = hs.Split();
        sendCipher = s;
        recvCipher = r;
        step = 4;
        onReady({ s, r }, (innerFrame) => daemonTransport.sendFrame(innerFrame));
        return;
      }
      if (recvCipher !== null) {
        recvCipher.DecryptWithAd(emptyAd, frame);
      }
    });

    return {
      getClientStatic: () => clientStatic,
      sendEncrypted: (pt) => {
        if (sendCipher === null) throw new Error("not ready");
        daemonTransport.sendFrame(sendCipher.EncryptWithAd(emptyAd, pt));
      },
      sendRaw: (ct) => daemonTransport.sendFrame(ct),
    };
  }

  it("completes XX handshake, verifies pin, exchanges encrypted payloads, and rejects replays", async () => {
    const deviceId = hexToBytes(GO_VECTOR.deviceIdHex);
    const clientKeys = await generateNoiseKeyPair();
    const daemonKeys = await generateNoiseKeyPair();
    const { client, daemon } = createLinkedTransports();

    let daemonSendCipher = null as NoiseCipherState | null;
    let daemonRecvCipher = null as NoiseCipherState | null;
    const daemonDecrypted: Uint8Array[] = [];

    const noise = await loadFreshNoiseRuntime();
    const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
    hs.Initialize(devicePrologue(deviceId), daemonKeys.privateKey, null, null);
    let step = 1;
    let clientStaticFromMsg3: Uint8Array | null = null;
    daemon.onFrame((frame) => {
      if (step === 1) {
        hs.ReadMessage(frame, false, false);
        step = 3;
        daemon.sendFrame(hs.WriteMessage(null));
      } else if (step === 3) {
        hs.ReadMessage(frame, false, false);
        clientStaticFromMsg3 = hs.GetRemotePublicKey();
        const [s, r] = hs.Split();
        daemonSendCipher = s;
        daemonRecvCipher = r;
        step = 4;
      } else if (daemonRecvCipher !== null) {
        daemonDecrypted.push(daemonRecvCipher.DecryptWithAd(new Uint8Array(0), frame));
      }
    });

    const factory = createNoiseChannelFactory();
    const session = await factory.open({
      transport: client,
      deviceId,
      pinnedNoisePublicKey: daemonKeys.publicKey,
      clientStaticPrivateKey: clientKeys.privateKey,
    });

    expect(clientStaticFromMsg3).toEqual(clientKeys.publicKey);

    const receivedByClient: Uint8Array[] = [];
    const errors: Error[] = [];
    session.onMessage((pt) => receivedByClient.push(pt));
    session.onError?.((err) => errors.push(err));

    const msg = new TextEncoder().encode('{"v":1,"method":"device.info"}');
    session.send(msg);
    await new Promise((r) => setTimeout(r, 10));
    expect(daemonDecrypted.map((b) => Array.from(b))).toEqual([Array.from(msg)]);

    const reply = new TextEncoder().encode('{"ok":true}');
    const ct = daemonSendCipher!.EncryptWithAd(new Uint8Array(0), reply);
    daemon.sendFrame(ct);
    await new Promise((r) => setTimeout(r, 10));
    expect(receivedByClient.map((b) => Array.from(b))).toEqual([Array.from(reply)]);

    // Replay the exact same ciphertext frame -> rejected with MAC error, nothing emitted.
    daemon.sendFrame(ct);
    await new Promise((r) => setTimeout(r, 10));
    expect(receivedByClient).toHaveLength(1);
    expect(errors).toHaveLength(1);

    // Oversized message rejected before encrypting.
    expect(() => session.send(new Uint8Array(MAX_RELAY_PLAINTEXT_SIZE + 1))).toThrow(
      NoisePayloadTooLargeError,
    );

    session.close();
    expect(() => session.send(msg)).toThrow(NoiseSessionClosedError);
    daemonSendCipher?.free();
    daemonRecvCipher?.free();
  });

  it("aborts after message 2 on pin mismatch without sending message 3", async () => {
    const deviceId = hexToBytes(GO_VECTOR.deviceIdHex);
    const clientKeys = await generateNoiseKeyPair();
    const attackerKeys = await generateNoiseKeyPair();
    const wrongPin = (await generateNoiseKeyPair()).publicKey;
    const { client, daemon, clientSent } = createLinkedTransports();

    await startResponder(daemon, deviceId, attackerKeys.privateKey, () => undefined);

    const factory = createNoiseChannelFactory();
    await expect(
      factory.open({
        transport: client,
        deviceId,
        pinnedNoisePublicKey: wrongPin,
        clientStaticPrivateKey: clientKeys.privateKey,
      }),
    ).rejects.toBeInstanceOf(NoisePinMismatchError);

    // Only msg1 was ever emitted; msg3 containing client's identity was never sent.
    expect(clientSent).toHaveLength(1);
  });

  it("times out cleanly when the responder does not reply", async () => {
    const deviceId = hexToBytes(GO_VECTOR.deviceIdHex);
    const clientKeys = await generateNoiseKeyPair();
    const daemonKeys = await generateNoiseKeyPair();
    const { client } = createLinkedTransports();

    const factory = createNoiseChannelFactory();
    await expect(
      factory.open({
        transport: client,
        deviceId,
        pinnedNoisePublicKey: daemonKeys.publicKey,
        clientStaticPrivateKey: clientKeys.privateKey,
        handshakeTimeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(NoiseHandshakeError);
  });
});
