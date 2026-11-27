import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../encoding";
import {
  checkInvitationBindings,
  INVITATION_PREFIX,
  MAX_INVITATION_TEXT_LENGTH,
  normalizeRelayUrl,
  parseInvitation,
  type UntrustedInvitation,
} from "./invitation";
import { asJson, asPrefixed, filled, NOW_MS, NOW_S, validWire } from "./testing";

function parseOk(text: string): UntrustedInvitation {
  const result = parseInvitation(text, NOW_MS);
  if (!result.ok) throw new Error(`expected a valid invitation: ${result.error.message}`);
  return result.value;
}

function errorCode(text: string): string {
  const result = parseInvitation(text, NOW_MS);
  if (result.ok) throw new Error("expected an error");
  return result.error.code;
}

describe("parseInvitation: valid input", () => {
  it("parses a JSON payload into a typed, untrusted structure", () => {
    const wire = validWire();
    const inv = parseOk(asJson(wire));
    expect(inv.trust).toBe("untrusted");
    expect(inv.version).toBe(1);
    expect(inv.relayUrl).toBe("wss://relay.example.com");
    expect(inv.deviceId).toHaveLength(32);
    expect(inv.deviceIdText).toBe(wire["device_id"]);
    expect(inv.registerPublicKey).toHaveLength(32);
    expect(inv.noisePublicKey).toHaveLength(32);
    expect(inv.invitationId).toHaveLength(32);
    expect(inv.invitationSecret).toHaveLength(32);
    expect(inv.signature).toHaveLength(64);
    expect(inv.expiresAt).toBe(NOW_S + 300);
  });

  it("parses the prefixed base64url form and tolerates surrounding whitespace", () => {
    const inv = parseOk(`  \n${asPrefixed(validWire())}\n `);
    expect(inv.relayUrl).toBe("wss://relay.example.com");
  });

  it("normalises the relay URL", () => {
    expect(parseOk(asJson(validWire({ relay: "wss://relay.example.com/" }))).relayUrl).toBe(
      "wss://relay.example.com",
    );
    expect(parseOk(asJson(validWire({ relay: "wss://relay.example.com/base/" }))).relayUrl).toBe(
      "wss://relay.example.com/base",
    );
  });

  it("allows ws:// only for a loopback development relay", () => {
    expect(normalizeRelayUrl("ws://localhost:8787")).toBe("ws://localhost:8787");
    expect(normalizeRelayUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787");
    expect(normalizeRelayUrl("ws://relay.example.com")).toBeNull();
  });
});

describe("parseInvitation: expiry", () => {
  it("rejects an invitation whose expiry has passed", () => {
    expect(errorCode(asJson(validWire({ expires_at: NOW_S - 1 })))).toBe("expired");
  });

  it("rejects an invitation expiring exactly now", () => {
    expect(errorCode(asJson(validWire({ expires_at: NOW_S })))).toBe("expired");
  });

  it("accepts an invitation one second before expiry", () => {
    expect(parseInvitation(asJson(validWire({ expires_at: NOW_S + 1 })), NOW_MS).ok).toBe(true);
  });

  it("rejects non-integer or non-positive expiry values", () => {
    for (const bad of [1.5, 0, -5, "1900000000", null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(errorCode(asJson(validWire({ expires_at: bad })))).toBe("invalid_field");
    }
  });
});

describe("parseInvitation: malformed input", () => {
  it("rejects empty and oversized text", () => {
    expect(errorCode("")).toBe("empty");
    expect(errorCode("   \n ")).toBe("empty");
    expect(errorCode("x".repeat(MAX_INVITATION_TEXT_LENGTH + 1))).toBe("too_long");
  });

  it("rejects text that is not JSON", () => {
    expect(errorCode("not an invitation")).toBe("malformed");
    expect(errorCode("{")).toBe("malformed");
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["[]", "null", "42", '"text"']) {
      expect(errorCode(text)).toBe("malformed");
    }
  });

  it("rejects a bad prefixed payload", () => {
    expect(errorCode(`${INVITATION_PREFIX}!!!`)).toBe("malformed");
    expect(errorCode(`${INVITATION_PREFIX}${encodeBase64Url(Uint8Array.of(0xff, 0xfe))}`)).toBe(
      "malformed",
    );
    expect(errorCode(`${INVITATION_PREFIX}${encodeBase64Url(new TextEncoder().encode("nope"))}`)).toBe(
      "malformed",
    );
  });

  it("rejects a missing or wrong version", () => {
    const { v: _v, ...withoutVersion } = validWire() as Record<string, unknown>;
    void _v;
    expect(errorCode(asJson(withoutVersion))).toBe("malformed");
    expect(errorCode(asJson(validWire({ v: "1" })))).toBe("malformed");
    expect(errorCode(asJson(validWire({ v: 2 })))).toBe("unsupported_version");
  });

  it("rejects every missing required field", () => {
    for (const key of [
      "relay",
      "device_id",
      "register_public_key",
      "noise_public_key",
      "invitation_id",
      "invitation_secret",
      "signature",
      "expires_at",
    ]) {
      const wire = validWire();
      delete wire[key];
      expect(errorCode(asJson(wire)), key).toBe("invalid_field");
    }
  });

  it("rejects fields of the wrong type", () => {
    expect(errorCode(asJson(validWire({ noise_public_key: 5 })))).toBe("invalid_field");
    expect(errorCode(asJson(validWire({ relay: ["wss://relay.example.com"] })))).toBe("invalid_field");
  });
});

describe("parseInvitation: wrong key lengths and encodings", () => {
  const fields: Array<[string, number]> = [
    ["register_public_key", 32],
    ["noise_public_key", 32],
    ["invitation_id", 32],
    ["invitation_secret", 32],
    ["signature", 64],
  ];

  for (const [field, size] of fields) {
    it(`rejects a ${field} that is too short or too long`, () => {
      expect(errorCode(asJson(validWire({ [field]: encodeBase64Url(filled(size - 1, 3)) })))).toBe(
        "invalid_field",
      );
      expect(errorCode(asJson(validWire({ [field]: encodeBase64Url(filled(size + 1, 3)) })))).toBe(
        "invalid_field",
      );
      expect(errorCode(asJson(validWire({ [field]: "" })))).toBe("invalid_field");
    });

    it(`rejects a ${field} outside the base64url alphabet`, () => {
      const good = encodeBase64Url(filled(size, 3));
      expect(errorCode(asJson(validWire({ [field]: `${good}=` })))).toBe("invalid_field");
      expect(errorCode(asJson(validWire({ [field]: good.replace(/.$/, "+") })))).toBe("invalid_field");
    });
  }

  it("rejects a device_id of the wrong length or alphabet", () => {
    expect(errorCode(asJson(validWire({ device_id: "mzxw6ytboi" })))).toBe("invalid_field");
    const good = String(validWire()["device_id"]);
    expect(errorCode(asJson(validWire({ device_id: good.toUpperCase() })))).toBe("invalid_field");
    expect(errorCode(asJson(validWire({ device_id: `${good}a` })))).toBe("invalid_field");
  });

  it("rejects relay URLs that are unsafe or not WebSocket URLs", () => {
    for (const relay of [
      "https://relay.example.com",
      "ws://relay.example.com",
      "wss://user:pass@relay.example.com",
      "wss://relay.example.com/?token=abc",
      "wss://relay.example.com/#frag",
      "relay.example.com",
      "",
    ]) {
      expect(errorCode(asJson(validWire({ relay }))), relay).toBe("invalid_field");
    }
  });
});

describe("checkInvitationBindings", () => {
  it("accepts a consistent invitation", async () => {
    expect(await checkInvitationBindings(parseOk(asJson(validWire())))).toBeNull();
  });

  it("rejects a device_id that is not SHA-256 of the registration key", async () => {
    const other = validWire({ register_public_key: encodeBase64Url(filled(32, 200)) });
    const error = await checkInvitationBindings(parseOk(asJson(other)));
    expect(error?.code).toBe("invalid_field");
    expect(error?.message).toContain("device_id");
  });

  it("rejects an invitation_id that does not match the secret", async () => {
    const other = validWire({ invitation_secret: encodeBase64Url(filled(32, 201)) });
    const error = await checkInvitationBindings(parseOk(asJson(other)));
    expect(error?.message).toContain("invitation_id");
  });
});

describe("error messages", () => {
  it("never echo secret or key material", () => {
    const wire = validWire({ invitation_secret: "short" });
    const result = parseInvitation(asJson(wire), NOW_MS);
    if (result.ok) throw new Error("expected an error");
    expect(result.error.message).not.toContain("short");
    expect(result.error.message).not.toContain(String(wire["register_public_key"]));
  });
});
