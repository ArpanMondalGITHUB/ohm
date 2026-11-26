import { describe, expect, it } from "vitest";
import { parseSSE } from "../src/providers/sse.ts";
import { collect, streamOf } from "./helpers.ts";

describe("parseSSE", () => {
  it("joins a line that was split across two chunks", async () => {
    expect(await collect(parseSSE(streamOf('data: {"a":', '1}\n\ndata: [DONE]\n\n')))).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("ignores comments and blank lines, and handles \\r\\n line endings", async () => {
    expect(await collect(parseSSE(streamOf(": OPENROUTER PROCESSING\n\n", "data: hi\r\n\r\n")))).toEqual(["hi"]);
  });

  it("ignores other SSE fields like event: and id:", async () => {
    expect(await collect(parseSSE(streamOf("event: message\nid: 7\ndata: x\n\n")))).toEqual(["x"]);
  });

  it("keeps the last line even when the stream ends without a newline", async () => {
    expect(await collect(parseSSE(streamOf("data: one\n\ndata: two")))).toEqual(["one", "two"]);
  });

  it("does not break a multi-byte character that is split between chunks", async () => {
    const bytes = new TextEncoder().encode("data: héllo 👋\n\n");
    const cut = bytes.length - 4; // cut inside the 4-byte emoji
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    expect(await collect(parseSSE(body))).toEqual(["héllo 👋"]);
  });

  it("returns nothing for an empty stream", async () => {
    expect(await collect(parseSSE(streamOf()))).toEqual([]);
  });
});
