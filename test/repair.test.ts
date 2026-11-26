import { describe, expect, it } from "vitest";
import { extractTextToolCalls, parseToolArgs } from "../src/agent/repair.ts";

const ok = { ok: true, value: { path: "a.ts" } };

describe("parseToolArgs", () => {
  it("parses normal JSON", () => expect(parseToolArgs('{"path":"a.ts"}')).toEqual(ok));
  it("strips ```json fences", () => expect(parseToolArgs('```json\n{"path":"a.ts"}\n```')).toEqual(ok));
  it("ignores text around the object", () => expect(parseToolArgs('Sure! {"path":"a.ts"} hope this helps')).toEqual(ok));
  it("removes trailing commas", () => expect(parseToolArgs('{"path":"a.ts",}')).toEqual(ok));
  it("handles JSON encoded twice", () => expect(parseToolArgs('"{\\"path\\":\\"a.ts\\"}"')).toEqual(ok));
  it("treats empty or whitespace as {}", () => {
    expect(parseToolArgs("")).toEqual({ ok: true, value: {} });
    expect(parseToolArgs("   ")).toEqual({ ok: true, value: {} });
  });
  it("reports garbage as an error", () => expect(parseToolArgs("not json").ok).toBe(false));
  it("rejects JSON that is not an object", () => {
    expect(parseToolArgs("[1,2]")).toEqual({ ok: false, error: "arguments must be a JSON object" });
    expect(parseToolArgs("42").ok).toBe(false);
  });
});

describe("extractTextToolCalls", () => {
  it("finds a tool call written as text", () => {
    const calls = extractTextToolCalls('I will read it.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "read", arguments: '{"path":"a.ts"}' });
  });

  it("finds several calls and gives each a different id", () => {
    const calls = extractTextToolCalls(
      '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call> and <tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>',
    );
    expect(calls.map((c) => c.arguments)).toEqual(['{"path":"a"}', '{"path":"b"}']);
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("keeps arguments that are already a string, and uses {} when they are missing", () => {
    const calls = extractTextToolCalls(
      '<tool_call>{"name":"a","arguments":"{\\"x\\":1}"}</tool_call><tool_call>{"name":"b"}</tool_call>',
    );
    expect(calls.map((c) => c.arguments)).toEqual(['{"x":1}', "{}"]);
  });

  it("skips blocks that are broken or have no name", () => {
    expect(extractTextToolCalls("<tool_call>oops</tool_call><tool_call>{\"arguments\":{}}</tool_call>")).toEqual([]);
  });

  it("returns nothing for plain text", () => {
    expect(extractTextToolCalls("Just an answer.")).toEqual([]);
  });
});
