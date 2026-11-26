import { spawn } from "node:child_process";
import { getShell } from "./shell.ts";
import type { Tool } from "../types.ts";

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project folder and get its output (stdout + stderr) and exit code. Use it to list files, search, run tests, use git, etc.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "number", description: "Timeout in seconds (default 60)" },
    },
    required: ["command"],
  },

  async execute(args, ctx) {
    if (!(await ctx.confirm(`Run: ${args.command}`))) {
      return "User denied this command. Ask them what to do instead, or try another approach.";
    }

    const shell = getShell();
    const timeoutMs = Number(args.timeout ?? 60) * 1000;

    return new Promise<string>((resolve) => {
      const child = spawn(shell.command, shell.args(args.command), {
        cwd: ctx.cwd,
        env: process.env,
        windowsHide: true,
      });

      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));

      const timer = setTimeout(() => {
        child.kill();
        output += `\n[killed after ${timeoutMs / 1000}s]`;
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`Failed to start shell: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(`exit code: ${code}\n${output}`);
      });
    });
  },
};
