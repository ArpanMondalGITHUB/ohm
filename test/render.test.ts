import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../src/render.ts";
import type { AgentEvent } from "../src/types.ts";
import { stripAnsi } from "./helpers.ts";

let written: string[];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => vi.restoreAllMocks());

/** What a list of events looks like on screen, without colors. */
function screen(...events: AgentEvent[]): string {
  for (const ev of events) render(ev);
  return stripAnsi(written.join(""));
}

describe("render", () => {
  it("prints text exactly as it streams in", () => {
    expect(screen({ type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo" })).toBe("Hello");
  });

  it("dims thinking", () => {
    screen({ type: "reasoning_delta", text: "hmm" });
    expect(written[0]).toBe("\x1b[2mhmm\x1b[0m");
  });

  it("shows a tool call as one line, cut at 100 characters", () => {
    const out = screen({ type: "tool_call", call: { id: "1", name: "write", arguments: `{"content":"${"x".repeat(200)}"}` } });
    expect(out).toContain("● write ");
    expect(out).toContain("…");
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("previews only the first 4 lines of a tool result", () => {
    const out = screen({ type: "tool_result", callId: "1", name: "read", output: "1\n2\n3\n4\n5\n6", isError: false });
    expect(out).toBe("1\n2\n3\n4\n… (2 more lines)\n");
  });

  it("prints tool errors in red", () => {
    screen({ type: "tool_result", callId: "1", name: "read", output: "Error: nope", isError: true });
    expect(written[0]).toContain("\x1b[31m");
  });

  it("shows token usage, cache, thinking and cost after a turn", () => {
    const out = screen({
      type: "turn_end",
      turn: 1,
      stopReason: "stop",
      usage: { inputTokens: 5120, outputTokens: 410, cachedInputTokens: 4300, reasoningTokens: 50, costUsd: 0.0021 },
    });
    expect(out).toContain("[in 5120 · out 410 · cached 4300 · thinking 50 · $0.0021]");
  });

  it("leaves out usage parts that are zero or missing", () => {
    const out = screen({ type: "turn_end", turn: 1, stopReason: "stop", usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 } });
    expect(out).toContain("[in 10 · out 2]");
  });

  it("warns when a reply was cut off", () => {
    expect(screen({ type: "turn_end", turn: 1, stopReason: "length" })).toContain("⚠ reply was cut off");
  });

  it("shows retries and errors", () => {
    expect(screen({ type: "retry", model: "m2", reason: "HTTP 429, retrying", delayMs: 4000 })).toContain(
      "↻ HTTP 429, retrying (next: m2, waiting 4s)",
    );
    expect(screen({ type: "error", message: "boom" })).toContain("Error: boom");
  });

  it("prints nothing for turn_start and message events", () => {
    expect(screen({ type: "turn_start", turn: 1 }, { type: "message", message: { role: "user", content: "x" } })).toBe("");
  });
});
