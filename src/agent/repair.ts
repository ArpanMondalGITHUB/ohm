import type { ToolCall } from "../types.ts";

export type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Try hard to turn whatever the model wrote into a JSON object. */
export function parseToolArgs(raw: string): ParseResult {
  if (raw.trim() === "") return { ok: true, value: {} };

  const extracted = extractObject(raw);
  const candidates = [raw, stripFences(raw), extracted, removeTrailingCommas(extracted)];

  let lastError = "unknown";
  for (const candidate of candidates) {
    try {
      let value = JSON.parse(candidate);
      if (typeof value === "string") value = JSON.parse(value); // JSON encoded twice, e.g. "{\"path\":...}"
      if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
      lastError = "arguments must be a JSON object";
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { ok: false, error: lastError };
}

const stripFences = (s: string) => s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

const extractObject = (s: string) => {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
};

const removeTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, "$1");

/** Find tool calls the model wrote as plain text: <tool_call>{"name":..,"arguments":{..}}</tool_call> */
export function extractTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let i = 0;
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const parsed = parseToolArgs(match[1]);
    if (!parsed.ok) continue;
    const { name, arguments: args } = parsed.value as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") continue;
    calls.push({
      id: `text_call_${Date.now()}_${i++}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  return calls;
}
