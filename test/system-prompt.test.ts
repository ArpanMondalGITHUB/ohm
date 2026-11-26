import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/system-prompt.ts";
import { readTool } from "../src/tools/read.ts";
import { makeTempDir, removeDir } from "./helpers.ts";

let project: string;
beforeEach(() => (project = makeTempDir("ohm-prompt-")));
afterEach(() => removeDir(project));

describe("buildSystemPrompt", () => {
  it("tells the model where it is: folder, OS and shell", () => {
    const prompt = buildSystemPrompt({ cwd: project, shellName: "bash (Git Bash on Windows)", tools: [], textTools: false });
    expect(prompt).toContain(`Working directory: ${project}`);
    expect(prompt).toContain(`OS: ${process.platform}`);
    expect(prompt).toContain("Shell used by the bash tool: bash (Git Bash on Windows)");
    expect(prompt).toContain("Always read a file before editing it");
  });

  it("adds the project's AGENTS.md when there is one", () => {
    writeFileSync(join(project, "AGENTS.md"), "Always answer in Hinglish.");
    const prompt = buildSystemPrompt({ cwd: project, shellName: "bash", tools: [], textTools: false });
    expect(prompt).toContain("Project instructions (from AGENTS.md):\nAlways answer in Hinglish.");
  });

  it("leaves project instructions out when there is no AGENTS.md", () => {
    expect(buildSystemPrompt({ cwd: project, shellName: "bash", tools: [], textTools: false })).not.toContain("AGENTS.md");
  });

  it("describes the tools in text only in text-tools mode", () => {
    const withText = buildSystemPrompt({ cwd: project, shellName: "bash", tools: [readTool], textTools: true });
    expect(withText).toContain("<tool_call>");
    expect(withText).toContain("- read: ");
    expect(withText).toContain(JSON.stringify(readTool.parameters));

    const native = buildSystemPrompt({ cwd: project, shellName: "bash", tools: [readTool], textTools: false });
    expect(native).not.toContain("<tool_call>");
  });

  it("is the same when built twice in one session (needed for prompt caching)", () => {
    const a = buildSystemPrompt({ cwd: project, shellName: "bash", tools: [], textTools: false });
    const b = buildSystemPrompt({ cwd: project, shellName: "bash", tools: [], textTools: false });
    expect(a).toBe(b);
  });
});
