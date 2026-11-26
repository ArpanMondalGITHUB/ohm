// Shared test helpers. This file has no tests itself (vitest only runs *.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";

/** Read every value from an async iterable (an async generator, a stream…) into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A fresh, empty folder in the OS temp directory. Remove it with removeDir(). */
export function makeTempDir(prefix = "ohm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A ReadableStream that delivers the given strings as separate network chunks. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A fake streaming HTTP response, like the one an LLM API sends. */
export function sseResponse(chunks: string[], status = 200): Response {
  return new Response(streamOf(...chunks), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** One OpenAI-style `data:` line. */
export const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A fake readline interface that answers questions from a list, in order. */
export function fakeReadline(answers: string[]): Interface & { asked: string[] } {
  const asked: string[] = [];
  const rl = {
    asked,
    question: async (prompt: string) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
  };
  return rl as unknown as Interface & { asked: string[] };
}

/** Remove terminal color codes so tests can compare plain text. */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[\d+m/g, "");
