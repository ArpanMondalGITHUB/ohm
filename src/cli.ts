import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.ts";
import { createOpenAICompatProvider } from "./providers/openai-compat.ts";
import type { Message } from "./types.ts";

const config = loadConfig();
const provider = createOpenAICompatProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
const messages: Message[] = [{ role: "system", content: "You are a helpful assistant." }];
const rl = readline.createInterface({ input: stdin, output: stdout });

// Ctrl+C: exit cleanly. Without this, the pending rl.question() never finishes
// and Node prints "Warning: Detected unsettled top-level await".
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

console.log(`ohm · model: ${config.models[0]} · type /exit to quit`);

while (true) {
  let line: string;
  try {
    line = await rl.question("\n> ");
  } catch {
    break; // Ctrl+D / closed input
  }
  if (line.trim() === "/exit") break;
  if (!line.trim()) continue;

  messages.push({ role: "user", content: line });
  let reply = "";
  try {
    for await (const ev of provider.stream({ model: config.models[0], messages, tools: [] })) {
      if (ev.type === "text_delta") {
        stdout.write(ev.text);
        reply += ev.text;
      }
    }
    messages.push({ role: "assistant", content: reply });
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    messages.pop(); // forget the failed question so history stays clean
  }
  stdout.write("\n");
}
rl.close();
