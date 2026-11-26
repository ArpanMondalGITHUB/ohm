import { existsSync } from "node:fs";

export interface Shell {
  name: string;                       // told to the model so it writes the right syntax
  command: string;
  args: (cmd: string) => string[];
}

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/** Pick a shell. Models write bash best, so we prefer Git Bash on Windows. */
export function getShell(): Shell {
  const bash = (command: string, name = "bash"): Shell => ({ name, command, args: (c) => ["-c", c] });

  if (process.env.OHM_SHELL) return bash(process.env.OHM_SHELL);
  if (process.platform !== "win32") return bash("bash");
  if (existsSync(GIT_BASH)) return bash(GIT_BASH, "bash (Git Bash on Windows)");
  return { name: "powershell", command: "powershell.exe", args: (c) => ["-NoProfile", "-Command", c] };
}
