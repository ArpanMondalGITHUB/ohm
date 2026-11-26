import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, loadOrSetupConfig, type Config } from "./config.ts";
import { readAuth, runSetup, setDefaultModel } from "./auth.ts";
import { createProvider } from "./providers/registry.ts";
import { runAgent } from "./agent/loop.ts";
import { buildSystemPrompt } from "./agent/system-prompt.ts";
import { builtinTools } from "./tools/index.ts";
import { getShell } from "./tools/shell.ts";
import { loadPluginTools } from "./plugin.ts";
import { dim, render } from "./render.ts";
import { latestSessionFile, loadMessages, replaySession, SessionLog } from "./session.ts";
import type { Message } from "./types.ts";

const args = process.argv.slice(2);

// `ohm replay [file]`: print a session and exit
if (args[0] === "replay") {
  replaySession(args[1] ?? latestSessionFile());
  process.exit(0);
}

const cwd = process.cwd();
const tools = [...builtinTools, ...(await loadPluginTools(cwd))];
const rl = readline.createInterface({ input: stdin, output: stdout });

// Ctrl+C: exit cleanly. Without this, the pending rl.question() never finishes
// and Node prints "Warning: Detected unsettled top-level await".
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

// First run: asks for a provider + API key and saves them (see auth.ts)
let config = await loadOrSetupConfig(rl);
let provider = createProvider(config);

/** Switch model/provider. The conversation (`messages`) stays the same. */
function useConfig(next: Config): void {
  config = next;
  provider = createProvider(next);
  console.log(dim(`Now using ${next.modelRef}`));
}

const confirm = async (question: string): Promise<boolean> => {
  if (process.env.OHM_YOLO === "1") return true;
  const answer = await rl.question(`${question} [y/N] `);
  return answer.trim().toLowerCase() === "y";
};

// New session or resume the last one
let log: SessionLog;
let messages: Message[];
const resumeFile = args.includes("--resume") ? latestSessionFile() : undefined;

if (resumeFile) {
  log = new SessionLog(resumeFile);
  messages = loadMessages(resumeFile);
  console.log(dim(`Resumed ${resumeFile} (${messages.length} messages)`));
} else {
  log = SessionLog.create();
  const system: Message = {
    role: "system",
    content: buildSystemPrompt({ cwd, shellName: getShell().name, tools, textTools: config.textTools }),
  };
  messages = [system];
  log.append({ type: "message", message: system });
}

console.log(`ohm · ${config.modelRef} · ${cwd} · /model /login /exit`);

while (true) {
  let line: string;
  try {
    line = await rl.question("\n> ");
  } catch {
    break;
  }
  const input = line.trim();
  if (input === "/exit") break;

  if (input === "/login") {
    await runSetup(rl);
    useConfig(await loadOrSetupConfig(rl));
    continue;
  }

  if (input === "/model" || input.startsWith("/model ")) {
    const ref = input.slice("/model".length).trim();
    if (!ref) {
      const withKeys = Object.keys(readAuth().providers);
      console.log(`Current: ${config.modelRef}`);
      console.log(`Providers with a key: ${withKeys.join(", ") || "none"}`);
      console.log("Switch with: /model <provider>/<model-id>");
      continue;
    }
    try {
      const next = loadConfig(ref);
      if (!next) {
        console.log("No API key saved for that provider. Run /login first.");
        continue;
      }
      setDefaultModel(ref); // the next run starts with this model too
      useConfig(next);
    } catch (err) {
      render({ type: "error", message: (err as Error).message });
    }
    continue;
  }

  if (!input) continue;

  const userMessage: Message = { role: "user", content: line };
  messages.push(userMessage);
  log.append({ type: "message", message: userMessage });

  try {
    for await (const ev of runAgent(messages, {
      provider,
      models: config.models,
      tools,
      cwd,
      confirm,
      textTools: config.textTools,
      reasoningEffort: config.reasoningEffort,
    })) {
      log.append(ev);
      render(ev);
    }
  } catch (err) {
    const ev = { type: "error" as const, message: (err as Error).message };
    log.append(ev);
    render(ev);
  }
}
rl.close();
