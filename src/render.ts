import type { AgentEvent, Usage } from "./types.ts";

const color = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const dim = color(2);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

function preview(text: string, maxLines = 4): string {
  const lines = text.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${head}\n… (${lines.length - maxLines} more lines)` : head;
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

function formatUsage(u: Usage): string {
  const parts = [`in ${u.inputTokens}`, `out ${u.outputTokens}`];
  if (u.cachedInputTokens) parts.push(`cached ${u.cachedInputTokens}`);
  if (u.reasoningTokens) parts.push(`thinking ${u.reasoningTokens}`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

/** Print one agent event in the terminal. */
export function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "text_delta":
      process.stdout.write(ev.text);
      break;
    case "reasoning_delta":
      process.stdout.write(dim(ev.text)); // thinking is shown dimmed
      break;
    case "turn_end":
      if (ev.stopReason === "length") process.stdout.write(yellow("\n⚠ reply was cut off (output token limit)\n"));
      if (ev.usage) process.stdout.write(dim(`\n[${formatUsage(ev.usage)}]\n`));
      break;
    case "tool_call":
      process.stdout.write(`\n${cyan(`● ${ev.call.name}`)} ${dim(oneLine(ev.call.arguments, 100))}\n`);
      break;
    case "tool_result": {
      const text = preview(ev.output);
      process.stdout.write((ev.isError ? red(text) : dim(text)) + "\n");
      break;
    }
    case "retry":
      process.stdout.write(yellow(`\n↻ ${ev.reason} (next: ${ev.model}, waiting ${Math.round(ev.delayMs / 1000)}s)\n`));
      break;
    case "error":
      process.stdout.write(red(`\nError: ${ev.message}\n`));
      break;
    case "agent_end":
      process.stdout.write("\n");
      break;
    // turn_start and message: nothing to show
  }
}
