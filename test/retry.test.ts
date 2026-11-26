import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamWithRetry } from "../src/agent/retry.ts";
import { ProviderError, type Provider, type ProviderEvent } from "../src/types.ts";
import { collect } from "./helpers.ts";

const done: ProviderEvent = { type: "done", stopReason: "stop" };
const hello: ProviderEvent = { type: "text_delta", text: "hello" };
const req = { messages: [], tools: [] };

/** A provider that throws the given errors (one per call) before finally succeeding. */
function failingThen(errors: Array<Error | null>): Provider & { models: string[] } {
  const models: string[] = [];
  return {
    name: "fake",
    models,
    async *stream({ model }) {
      models.push(model);
      const err = errors.shift();
      if (err) throw err;
      yield hello;
      yield done;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("streamWithRetry", () => {
  it("passes events through when the first try works", async () => {
    const provider = failingThen([null]);
    expect(await collect(streamWithRetry(provider, ["m1"], req))).toEqual([hello, done]);
    expect(provider.models).toEqual(["m1"]);
  });

  it("retries the same model after 2s on HTTP 429", async () => {
    const provider = failingThen([new ProviderError(429, "slow down"), null]);
    const result = collect(streamWithRetry(provider, ["m1"], req));
    await vi.advanceTimersByTimeAsync(2000);
    const events = await result;
    expect(events[0]).toEqual({ type: "retry", model: "m1", reason: "HTTP 429, retrying", delayMs: 2000 });
    expect(events.slice(1)).toEqual([hello, done]);
    expect(provider.models).toEqual(["m1", "m1"]);
  });

  it("treats 5xx and network errors (no status) as temporary too, waiting 2s then 4s", async () => {
    const provider = failingThen([new ProviderError(503, "overloaded"), new TypeError("fetch failed"), null]);
    const result = collect(streamWithRetry(provider, ["m1"], req));
    await vi.advanceTimersByTimeAsync(6000);
    const retries = (await result).filter((e) => e.type === "retry");
    expect(retries.map((e) => (e.type === "retry" ? e.delayMs : 0))).toEqual([2000, 4000]);
    expect(retries[1]).toMatchObject({ reason: "HTTP network error, retrying" });
  });

  it("gives up after 3 tries on one model and throws the last error", async () => {
    const provider = failingThen([
      new ProviderError(429, "a"),
      new ProviderError(429, "b"),
      new ProviderError(429, "last"),
    ]);
    const result = collect(streamWithRetry(provider, ["m1"], req));
    const assertion = expect(result).rejects.toThrow("last");
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(provider.models).toEqual(["m1", "m1", "m1"]);
  });

  it("switches to the next model right away on a permanent error (e.g. 400/404)", async () => {
    const provider = failingThen([new ProviderError(404, "unknown model"), null]);
    const events = await collect(streamWithRetry(provider, ["bad", "good"], req));
    expect(events[0]).toEqual({ type: "retry", model: "good", reason: "switching model (unknown model)", delayMs: 0 });
    expect(provider.models).toEqual(["bad", "good"]);
  });

  it("switches model after the temporary-error retries run out", async () => {
    const provider = failingThen([new ProviderError(429, "x"), new ProviderError(429, "x"), new ProviderError(429, "x"), null]);
    const result = collect(streamWithRetry(provider, ["m1", "m2"], req));
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    expect(provider.models).toEqual(["m1", "m1", "m1", "m2"]);
  });

  it("throws the last error when every model fails", async () => {
    const provider = failingThen([new ProviderError(400, "first"), new ProviderError(400, "second")]);
    await expect(collect(streamWithRetry(provider, ["a", "b"], req))).rejects.toThrow("second");
  });

  it("never retries once the reply has started streaming (no duplicate text)", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "dies-midway",
      async *stream() {
        calls++;
        yield hello;
        throw new ProviderError(500, "connection lost");
      },
    };
    await expect(collect(streamWithRetry(provider, ["m1", "m2"], req))).rejects.toThrow("connection lost");
    expect(calls).toBe(1);
  });

  it("does not retry when the request was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = failingThen([new ProviderError(429, "x"), null]);
    await expect(collect(streamWithRetry(provider, ["m1"], { ...req, signal: controller.signal }))).rejects.toThrow("x");
    expect(provider.models).toEqual(["m1"]);
  });

  it("throws a clear error when no models are configured", async () => {
    await expect(collect(streamWithRetry(failingThen([]), [], req))).rejects.toThrow("No models configured");
  });
});
