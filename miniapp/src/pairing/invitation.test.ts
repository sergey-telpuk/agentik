import { describe, expect, it } from "vitest";
import { encodeBase32, encodeBase64, encodeBase64Url } from "../encoding";
import {
  DEFAULT_RELAY_URL,
  INVITATION_FIXED_SIZE,
  INVITATION_PREFIX,
  MAX_INVITATION_TEXT_LENGTH,
  normalizeRelayUrl,
  parseInvitation,
  type UntrustedInvitation,
} from "./invitation";
import { asText, filled, NOW_MS, NOW_S, payloadFromText, textFromPayload, validWire } from "./testing";

async function parseOk(text: string, nowMs = NOW_MS): Promise<UntrustedInvitation> {
  const result = await parseInvitation(text, nowMs);
  if (!result.ok) throw new Error(`expected a valid invitation: ${result.error.message}`);
  return result.value;
}

async function errorCode(text: string, nowMs = NOW_MS): Promise<string> {
  const result = await parseInvitation(text, nowMs);
  if (result.ok) throw new Error("expected an error");
  return result.error.code;
}

/**
 * Printed by the daemon test TestInvitationCrossLanguageVector
 * (daemon/internal/pairing/invitation_test.go) from fixed inputs: register
 * Ed25519 seed bytes 0x00..0x1f, Noise scalar bytes 0x20..0x3f, invitation
 * secret bytes 0x40..0x5f, expiry 1900000000. Change both sides together.
 */
const VECTOR_EXPIRY = 1_900_000_000;
const VECTORS = [
  {
    name: "default relay",
    relayUrl: DEFAULT_RELAY_URL,
    payloadSize: 166,
    text:
      "AGENTIK1:AEAAHIIHX7Z44EF6DVYN2GHHJPAJSZ7E2YYJXJINL4O5ZBTECJKTDOBVQBZNMNSYQDI252RSTLPZCIJYHBI62INCRY" +
      "5XL2LF2DJM2FTCKRAECQSDIRCUMR2IJFFEWTCNJZHVAUKSKNKFKVSXLBMVUW24LVPF64J7WMAJVZBXFZ5ZPH3CJLUQULYL2QR63ZNG" +
      "2PRWNIDFCHZDWIEGUGZSCXOHDEEHU7J32GD37D4GU367HD552QBXBI5GX52AHLLG2NCFZQDFBQ",
  },
  {
    name: "custom wss relay",
    relayUrl: "wss://relay.example.com/base",
    payloadSize: 188,
    text:
      "AGENTIK1:AEAQHIIHX7Z44EF6DVYN2GHHJPAJSZ7E2YYJXJINL4O5ZBTECJKTDOBVQBZNMNSYQDI252RSTLPZCIJYHBI62INCRY" +
      "5XL2LF2DJM2FTCKRAECQSDIRCUMR2IJFFEWTCNJZHVAUKSKNKFKVSXLBMVUW24LVPF64J7WMAKB5QDSDDS5UJ3CUBDZ5PZFKIVM2GD" +
      "VV7R57U6J3SGG5ZQVS5TYMW2VMUPNHQI5GRYYUMGGM2NWQ5542PTGLQX525BU6Z4PJRPBT7RBFZGK3DBPEXGK6DBNVYGYZJOMNXW2L3CMFZWK",
  },
];
const VECTOR_DEVICE_ID = "kzdvvj2umnduyauf35o36k6kw462mujvra46tn3uqgzovmihocga";
const VECTOR_REGISTER_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const VECTOR_NOISE_KEY = "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=";
const sequence = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => start + i);

describe("cross-language vector", () => {
  const before = (VECTOR_EXPIRY - 60) * 1000;

  for (const v of VECTORS) {
    it(`parses and verifies the daemon's ${v.name} invitation`, async () => {
      expect(payloadFromText(v.text)).toHaveLength(v.payloadSize);
      const inv = await parseOk(v.text, before);
      expect(inv.trust).toBe("untrusted");
      expect(inv.version).toBe(1);
      expect(inv.relayUrl).toBe(v.relayUrl);
      expect(inv.deviceIdText).toBe(VECTOR_DEVICE_ID);
      expect(encodeBase64(inv.registerPublicKey)).toBe(VECTOR_REGISTER_KEY);
      expect(encodeBase64(inv.noisePublicKey)).toBe(VECTOR_NOISE_KEY);
      expect(inv.invitationSecret).toEqual(sequence(0x40));
      expect(inv.expiresAt).toBe(VECTOR_EXPIRY);
      expect(inv.signature).toHaveLength(64);
    });

    it(`rejects the ${v.name} vector at and after expiry`, async () => {
      expect(await errorCode(v.text, VECTOR_EXPIRY * 1000)).toBe("expired");
      expect(await errorCode(v.text, (VECTOR_EXPIRY + 1) * 1000)).toBe("expired");
    });
  }

  it("rejects the vector with any single byte changed", async () => {
    const vector = VECTORS[1];
    if (vector === undefined) throw new Error("missing vector");
    const raw = payloadFromText(vector.text);
    for (let i = 0; i < raw.length; i++) {
      const mutated = raw.slice();
      mutated[i] = (mutated[i] ?? 0) ^ 0x01;
      const result = await parseInvitation(textFromPayload(mutated), before);
      expect(result.ok, `byte ${i}`).toBe(false);
    }
  });
});

describe("parseInvitation: valid input", () => {
  it("parses an invitation into a typed, untrusted structure with derived ids", async () => {
    const wire = validWire();
    const inv = await parseOk(asText(wire));
    expect(inv.trust).toBe("untrusted");
    expect(inv.relayUrl).toBe("wss://relay.example.com");
    expect(inv.deviceIdText).toBe(wire["device_id"]);
    expect(encodeBase64Url(inv.registerPublicKey)).toBe(wire["register_public_key"]);
    expect(encodeBase64Url(inv.noisePublicKey)).toBe(wire["noise_public_key"]);
    expect(encodeBase64Url(inv.invitationId)).toBe(wire["invitation_id"]);
    expect(encodeBase64Url(inv.invitationSecret)).toBe(wire["invitation_secret"]);
    expect(inv.expiresAt).toBe(NOW_S + 300);
  });

  it("tolerates terminal line wraps, surrounding whitespace, and lowercase", async () => {
    const text = asText(validWire());
    const wrapped = `  \n${text.slice(0, 70)}\n${text.slice(70, 140)} \r\n\t${text.slice(140).toLowerCase()}\n `;
    expect((await parseOk(wrapped)).relayUrl).toBe("wss://relay.example.com");
  });

  it("carries the default relay as a selector only", async () => {
    const text = asText(validWire({ relay: DEFAULT_RELAY_URL }));
    expect(payloadFromText(text)).toHaveLength(INVITATION_FIXED_SIZE);
    expect((await parseOk(text)).relayUrl).toBe(DEFAULT_RELAY_URL);
  });

  it("accepts custom wss relays with a port and path, and ws on loopback", async () => {
    for (const relay of ["wss://relay.example.com:8443/base", "ws://localhost:8787", "ws://127.0.0.1:8787"]) {
      expect((await parseOk(asText(validWire({ relay })))).relayUrl).toBe(relay);
    }
  });

  it("normalises relay URLs on their own", () => {
    expect(normalizeRelayUrl("wss://relay.example.com/")).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl("wss://relay.example.com/base/")).toBe("wss://relay.example.com/base");
    expect(normalizeRelayUrl("ws://relay.example.com")).toBeNull();
  });
});

describe("parseInvitation: expiry", () => {
  it("rejects an invitation whose expiry has passed", async () => {
    expect(await errorCode(asText(validWire({ expires_at: NOW_S - 1 })))).toBe("expired");
  });

  it("rejects an invitation expiring exactly now", async () => {
    expect(await errorCode(asText(validWire({ expires_at: NOW_S })))).toBe("expired");
  });

  it("accepts an invitation one second before expiry", async () => {
    expect((await parseInvitation(asText(validWire({ expires_at: NOW_S + 1 })), NOW_MS)).ok).toBe(true);
  });

  it("rejects a zero expiry", async () => {
    expect(await errorCode(asText(validWire({ expires_at: 0 })))).toBe("invalid_field");
  });
});

describe("parseInvitation: tampering", () => {
  const raw = () => payloadFromText(asText(validWire()));

  it("rejects a swapped Noise key", async () => {
    const mutated = raw();
    mutated.set(filled(32, 77), 34);
    expect(await errorCode(textFromPayload(mutated))).toBe("bad_signature");
  });

  it("rejects a changed expiry, secret, relay, or signature", async () => {
    for (const index of [101, 70, 170, 120]) {
      const mutated = raw();
      mutated[index] = (mutated[index] ?? 0) ^ 0x01;
      expect(await errorCode(textFromPayload(mutated)), `byte ${index}`).toBe("bad_signature");
    }
  });

  it("rejects a swapped registration key", async () => {
    const mutated = raw();
    mutated.set(filled(32, 5), 2);
    expect(await errorCode(textFromPayload(mutated))).toBe("bad_signature");
  });
});

describe("parseInvitation: malformed input", () => {
  it("rejects empty and oversized text", async () => {
    expect(await errorCode("")).toBe("empty");
    expect(await errorCode("   \n ")).toBe("empty");
    expect(await errorCode(INVITATION_PREFIX + "A".repeat(MAX_INVITATION_TEXT_LENGTH))).toBe("too_long");
    expect(await errorCode(" ".repeat(MAX_INVITATION_TEXT_LENGTH * 4 + 1))).toBe("too_long");
  });

  it("rejects text without the prefix, including the old JSON format", async () => {
    expect(await errorCode("not an invitation")).toBe("malformed");
    expect(await errorCode('{"v":1,"relay":"wss://relay.example.com"}')).toBe("malformed");
    expect(await errorCode("agentik-pair-v1:eyJ2IjoxfQ")).toBe("malformed");
  });

  it("rejects a payload outside the base32 alphabet or not canonical", async () => {
    expect(await errorCode(`${INVITATION_PREFIX}!!!!`)).toBe("malformed");
    expect(await errorCode(`${INVITATION_PREFIX}AEAQ1`)).toBe("malformed");
    expect(await errorCode(`${INVITATION_PREFIX}AB`)).toBe("malformed");
  });

  it("rejects a truncated payload", async () => {
    const short = payloadFromText(asText(validWire({ relay: DEFAULT_RELAY_URL }))).slice(0, INVITATION_FIXED_SIZE - 1);
    expect(await errorCode(textFromPayload(short))).toBe("malformed");
  });

  it("rejects an unknown version", async () => {
    const mutated = payloadFromText(asText(validWire()));
    mutated[0] = 2;
    expect(await errorCode(textFromPayload(mutated))).toBe("unsupported_version");
  });

  it("rejects unknown relay selectors and unsafe or non-canonical relays", async () => {
    const base = payloadFromText(asText(validWire({ relay: DEFAULT_RELAY_URL })));
    const withRelay = (selector: number, rest: string) => {
      const tail = new TextEncoder().encode(rest);
      const out = new Uint8Array(base.length + tail.length);
      out.set(base);
      out.set(tail, base.length);
      out[1] = selector;
      return textFromPayload(out);
    };
    expect(await errorCode(withRelay(3, "relay.example.com"))).toBe("invalid_field");
    expect(await errorCode(withRelay(0, "relay.example.com"))).toBe("invalid_field");
    expect(await errorCode(withRelay(2, "relay.example.com"))).toBe("invalid_field");
    expect(await errorCode(withRelay(1, "user:pass@relay.example.com"))).toBe("invalid_field");
    expect(await errorCode(withRelay(1, "relay.example.com/?token=abc"))).toBe("invalid_field");
    expect(await errorCode(withRelay(1, "relay.example.com/"))).toBe("invalid_field");
    expect(await errorCode(withRelay(1, DEFAULT_RELAY_URL.slice("wss://".length)))).toBe("invalid_field");
  });
});

describe("error messages", () => {
  it("never echo secret or key material", async () => {
    const wire = validWire();
    const text = asText(wire);
    const mutated = payloadFromText(text);
    mutated[120] = (mutated[120] ?? 0) ^ 0xff;
    const result = await parseInvitation(textFromPayload(mutated), NOW_MS);
    if (result.ok) throw new Error("expected an error");
    for (const secret of [
      String(wire["invitation_secret"]),
      String(wire["register_public_key"]),
      encodeBase32(payloadFromText(text)).slice(0, 20),
    ]) {
      expect(result.error.message).not.toContain(secret);
    }
  });
});
