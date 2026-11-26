import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Message } from "./types.ts";

export const SESSIONS_DIR = join(homedir(), ".ohm", "sessions");

/** Adds one JSON line per event to a .jsonl file. */
export class SessionLog {
  constructor(public readonly file: string) {}

  static create(): SessionLog {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const name = new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl";
    return new SessionLog(join(SESSIONS_DIR, name));
  }

  append(event: AgentEvent): void {
    // too noisy; the full text is in the "message" event (thinking isn't saved at all)
    if (event.type === "text_delta" || event.type === "reasoning_delta") return;
    appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  }
}

/** The newest session file (names are timestamps, so sorting them puts the newest last). */
export function latestSessionFile(): string | undefined {
  if (!existsSync(SESSIONS_DIR)) return undefined;
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  return files.length ? join(SESSIONS_DIR, files[files.length - 1]) : undefined;
}

function readEntries(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Rebuild the conversation history from a log: only the "message" events matter. */
export function loadMessages(file: string): Message[] {
  return readEntries(file)
    .filter((e) => e.type === "message")
    .map((e) => e.message as Message);
}

/** Print a session in a readable way. */
export function replaySession(file: string | undefined): void {
  if (!file || !existsSync(file)) {
    console.error("No session found.");
    return;
  }
  console.log(`Replaying ${file}\n`);
  for (const entry of readEntries(file)) {
    const time = new Date(entry.ts).toLocaleTimeString();
    if (entry.type === "message") {
      const m = entry.message as Message;
      if (m.role === "assistant") {
        console.log(`\n[${time}] assistant: ${m.content}`);
        for (const c of m.toolCalls ?? []) console.log(`    → ${c.name} ${c.arguments}`);
      } else if (m.role === "tool") {
        console.log(`[${time}] tool result: ${m.content.slice(0, 300)}`);
      } else {
        const content = m.role === "system" ? m.content.slice(0, 150) + "…" : m.content;
        console.log(`\n[${time}] ${m.role}: ${content}`);
      }
    } else if (entry.type === "retry" || entry.type === "error") {
      console.log(`[${time}] ${entry.type}: ${entry.reason ?? entry.message}`);
    }
  }
}
