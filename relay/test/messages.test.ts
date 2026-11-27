/**
 * Unit tests for the outer envelope parser.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_ID_LENGTH,
  maxMessageLength,
  parseClientMessage,
} from "../src/messages";
import { encodeBase64 } from "../src/protocol";

const MAX_FRAME = 32 * 1024;

describe("envelope parser", () => {
  it("rejects an oversized message before parsing it", () => {
    // Not JSON at all: if parsing ran first this would be bad_request.
    const raw = "x".repeat(maxMessageLength(MAX_FRAME) + 1);
    const result = parseClientMessage(raw, MAX_FRAME);
    expect(result).toMatchObject({ ok: false, code: "message_too_large" });
  });

  it("accepts the largest legitimate frame", () => {
    const raw = JSON.stringify({
      type: "frame",
      data: encodeBase64(new Uint8Array(MAX_FRAME)),
      connection_id: "f".repeat(32),
    });
    expect(raw.length).toBeLessThanOrEqual(maxMessageLength(MAX_FRAME));
    const result = parseClientMessage(raw, MAX_FRAME);
    expect(result.ok).toBe(true);
  });

  it("rejects frame data that encodes more than the payload limit", () => {
    const raw = JSON.stringify({
      type: "frame",
      data: encodeBase64(new Uint8Array(MAX_FRAME + 1)),
    });
    const result = parseClientMessage(raw, MAX_FRAME);
    expect(result).toMatchObject({ ok: false, code: "message_too_large" });
  });

  it("bounds the relay id", () => {
    const raw = JSON.stringify({
      type: "register",
      version: 1,
      role: "device",
      relay_id: "r".repeat(MAX_RELAY_ID_LENGTH + 1),
    });
    const result = parseClientMessage(raw, MAX_FRAME);
    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "relay_id is too long" });
  });

  it("validates the connection id format", () => {
    for (const connectionId of ["", "F".repeat(32), "f".repeat(31), "f".repeat(33), 7]) {
      const raw = JSON.stringify({ type: "frame", data: "AQ==", connection_id: connectionId });
      expect(parseClientMessage(raw, MAX_FRAME)).toMatchObject({ ok: false, code: "bad_request" });
    }
  });
});
