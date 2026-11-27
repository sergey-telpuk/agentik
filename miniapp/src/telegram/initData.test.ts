import { describe, expect, it, vi } from "vitest";
import type { SecureSession } from "../secure/seam";
import {
  buildInitDataVerificationRequest,
  INIT_DATA_METHOD,
  MAX_INIT_DATA_LENGTH,
  readRawInitData,
  sendInitDataVerification,
} from "./initData";

const RAW = "query_id=AAH&user=%7B%22id%22%3A1%7D&auth_date=1700000000&signature=abc";

describe("readRawInitData", () => {
  it("returns the raw string untouched", () => {
    const result = readRawInitData({ isMiniApp: true, rawInitData: () => RAW });
    expect(result).toEqual({ ok: true, rawInitData: RAW });
  });

  it("reports when not running inside Telegram, without reading anything", () => {
    const rawInitData = vi.fn(() => RAW);
    expect(readRawInitData({ isMiniApp: false, rawInitData })).toEqual({
      ok: false,
      reason: "not_in_telegram",
    });
    expect(rawInitData).not.toHaveBeenCalled();
  });

  it("reports missing and oversized data", () => {
    expect(readRawInitData({ isMiniApp: true, rawInitData: () => null })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(readRawInitData({ isMiniApp: true, rawInitData: () => "" })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      readRawInitData({ isMiniApp: true, rawInitData: () => "a".repeat(MAX_INIT_DATA_LENGTH + 1) }),
    ).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("buildInitDataVerificationRequest", () => {
  it("wraps the raw string without parsing or altering it", () => {
    const request = buildInitDataVerificationRequest(RAW, "req-1");
    expect(request).toEqual({
      v: 1,
      request_id: "req-1",
      method: INIT_DATA_METHOD,
      params: { init_data: RAW },
    });
  });

  it("generates a fresh request id by default", () => {
    const a = buildInitDataVerificationRequest(RAW);
    const b = buildInitDataVerificationRequest(RAW);
    expect(a.request_id).not.toBe(b.request_id);
  });
});

describe("sendInitDataVerification", () => {
  it("sends only through a secure session", () => {
    const sent: Uint8Array[] = [];
    const session: SecureSession = {
      send: (plaintext) => sent.push(plaintext),
      onMessage: () => () => undefined,
      close: () => undefined,
    };
    const id = sendInitDataVerification(session, RAW);
    expect(sent).toHaveLength(1);
    const message = JSON.parse(new TextDecoder().decode(sent[0])) as {
      request_id: string;
      params: { init_data: string };
    };
    expect(message.request_id).toBe(id);
    expect(message.params.init_data).toBe(RAW);
  });
});
