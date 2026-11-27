import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ApiResult } from "../../api/types";
import { TerminalInputQueue } from "./inputQueue";

afterEach(() => {
  vi.useRealTimers();
});

const dec = new TextDecoder();

describe("terminal input queue", () => {
  it("sends in order with one request in flight, joining input typed meanwhile", async () => {
    const sent: string[] = [];
    const resolvers: ((r: ApiResult<null>) => void)[] = [];
    const queue = new TerminalInputQueue(
      (data) => {
        sent.push(dec.decode(data));
        return new Promise((resolve) => resolvers.push(resolve));
      },
      () => undefined,
    );
    queue.push("l");
    queue.push("s");
    queue.push("\r");
    expect(sent).toEqual(["l"]);
    resolvers.shift()?.({ ok: true, value: null });
    await vi.waitFor(() => expect(sent).toEqual(["l", "s\r"]));
    resolvers.shift()?.({ ok: true, value: null });
  });

  it("splits input at the size limit", async () => {
    const sizes: number[] = [];
    const queue = new TerminalInputQueue(
      (data) => {
        sizes.push(data.length);
        return Promise.resolve({ ok: true, value: null });
      },
      () => undefined,
    );
    queue.push("a".repeat(4096 * 2 + 10));
    await vi.waitFor(() => expect(sizes).toEqual([4096, 4096, 10]));
  });

  it("retries a busy computer and reports other errors", async () => {
    vi.useFakeTimers();
    const results: ApiResult<null>[] = [
      { ok: false, error: { code: "busy", message: "full" } },
      { ok: true, value: null },
      { ok: false, error: { code: "not_found", message: "The terminal session has ended." } },
    ];
    const sent: string[] = [];
    const errors: ApiError[] = [];
    const queue = new TerminalInputQueue(
      (data) => {
        sent.push(dec.decode(data));
        return Promise.resolve(results.shift() ?? { ok: true, value: null });
      },
      (e) => errors.push(e),
    );
    queue.push("a");
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toEqual(["a", "a"]);
    queue.push("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.map((e) => e.code)).toEqual(["not_found"]);
  });
});
