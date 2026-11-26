import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the home folder at a temp folder, so these tests never touch your real ~/.ohm/sessions.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const { join } = await import("node:path");
  const home = join(os.tmpdir(), `ohm-test-home-session-${process.pid}`);
  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { latestSessionFile, loadMessages, replaySession, SessionLog, SESSIONS_DIR } from "../src/session.ts";
import type { Message } from "../src/types.ts";

beforeEach(() => {
  if (!SESSIONS_DIR.includes("ohm-test-home-session")) throw new Error(`refusing to touch ${SESSIONS_DIR}`);
  rmSync(homedir(), { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("SessionLog", () => {
  it("creates a .jsonl file named after the time, in ~/.ohm/sessions", () => {
    const log = SessionLog.create();
    expect(existsSync(SESSIONS_DIR)).toBe(true);
    expect(log.file.startsWith(SESSIONS_DIR)).toBe(true);
    expect(log.file).toMatch(/\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/);
  });

  it("writes one JSON line per event, with a timestamp", () => {
    const log = SessionLog.create();
    log.append({ type: "turn_start", turn: 1 });
    log.append({ type: "error", message: "boom" });
    const entries = lines(log.file);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ type: "error", message: "boom" });
    expect(typeof entries[0].ts).toBe("number");
  });

  it("skips text and thinking pieces (the full text is in the message event)", () => {
    const log = SessionLog.create();
    log.append({ type: "text_delta", text: "a" });
    log.append({ type: "reasoning_delta", text: "b" });
    log.append({ type: "agent_end" });
    expect(lines(log.file).map((e) => e.type)).toEqual(["agent_end"]);
  });
});

describe("loadMessages (resume)", () => {
  it("rebuilds the conversation from the message events only", () => {
    const log = SessionLog.create();
    const history: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "1", content: "file" },
      { role: "assistant", content: "done", replay: { api: "anthropic", data: [{ type: "thinking", signature: "s" }] } },
    ];
    log.append({ type: "turn_start", turn: 1 });
    for (const message of history) log.append({ type: "message", message });
    log.append({ type: "agent_end" });
    expect(loadMessages(log.file)).toEqual(history); // replay data survives, so Claude can resume
  });
});

describe("latestSessionFile", () => {
  it("returns undefined when there are no sessions", () => {
    expect(latestSessionFile()).toBeUndefined();
  });

  it("returns the newest .jsonl file", () => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(join(SESSIONS_DIR, "2026-01-01T10-00-00-000Z.jsonl"), "");
    writeFileSync(join(SESSIONS_DIR, "2026-03-01T10-00-00-000Z.jsonl"), "");
    writeFileSync(join(SESSIONS_DIR, "2026-02-01T10-00-00-000Z.jsonl"), "");
    writeFileSync(join(SESSIONS_DIR, "notes.txt"), "");
    expect(latestSessionFile()).toBe(join(SESSIONS_DIR, "2026-03-01T10-00-00-000Z.jsonl"));
  });
});

describe("replaySession", () => {
  it("prints the conversation in a readable way", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const session = SessionLog.create();
    session.append({ type: "message", message: { role: "user", content: "read a.ts" } });
    session.append({ type: "message", message: { role: "assistant", content: "ok", toolCalls: [{ id: "1", name: "read", arguments: '{"path":"a.ts"}' }] } });
    session.append({ type: "message", message: { role: "tool", toolCallId: "1", content: "contents" } });
    session.append({ type: "retry", model: "m2", reason: "HTTP 429, retrying", delayMs: 2000 });
    session.append({ type: "error", message: "boom" });
    replaySession(session.file);

    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("user: read a.ts");
    expect(printed).toContain("assistant: ok");
    expect(printed).toContain('→ read {"path":"a.ts"}');
    expect(printed).toContain("tool result: contents");
    expect(printed).toContain("retry: HTTP 429, retrying");
    expect(printed).toContain("error: boom");
  });

  it("says so when there is no session", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    replaySession(undefined);
    replaySession(join(SESSIONS_DIR, "missing.jsonl"));
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("No session found.");
  });
});
