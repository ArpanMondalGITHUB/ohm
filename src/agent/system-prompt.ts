import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.ts";

export interface PromptOptions {
  cwd: string;
  shellName: string;
  tools: Tool[];
  textTools: boolean;
}

export function buildSystemPrompt({ cwd, shellName, tools, textTools }: PromptOptions): string {
  const parts: string[] = [
    `You are ohm, a coding agent running in the user's terminal.
You help with software tasks by reading files, editing them, and running commands.

Environment:
- Working directory: ${cwd}
- OS: ${process.platform}
- Shell used by the bash tool: ${shellName}
- Date: ${new Date().toISOString().slice(0, 10)}

How to work:
- Look before you act: use bash (ls, grep) and read to understand the code first. Never guess file contents.
- Always read a file before editing it. Copy old_string exactly from what read returned.
- Prefer small edits over rewriting whole files.
- After changing code, run the project's tests or build if there is one.
- If a tool returns an error, read it carefully and try again with a fix.
- Keep replies short: say what you did and what's left.`,
  ];

  const agentsFile = join(cwd, "AGENTS.md");
  if (existsSync(agentsFile)) {
    parts.push(`Project instructions (from AGENTS.md):\n${readFileSync(agentsFile, "utf8")}`);
  }

  if (textTools) parts.push(textToolInstructions(tools));

  return parts.join("\n\n");
}

/** For models without native tool support (Task 6): describe the tools in plain text. */
function textToolInstructions(tools: Tool[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return `To use a tool, write exactly this and then stop and wait:
<tool_call>{"name": "TOOL_NAME", "arguments": { ... }}</tool_call>
The result will come back in a <tool_result> message.

Available tools:
${list}`;
}
