import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { builtinTools } from "../src/tools/index.ts";
import { resolvePath } from "../src/tools/paths.ts";
import { readTool } from "../src/tools/read.ts";
import { getShell } from "../src/tools/shell.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolContext } from "../src/types.ts";
import { makeTempDir, removeDir } from "./helpers.ts";

let project: string;
let ctx: ToolContext;

beforeEach(() => {
  project = makeTempDir("ohm-tools-");
  ctx = { cwd: project, confirm: async () => true };
});
afterEach(() => removeDir(project));

describe("builtinTools", () => {
  it("has read, write, edit and bash, each with a valid schema", () => {
    expect(builtinTools.map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
    for (const t of builtinTools) {
      expect(t.parameters.type).toBe("object");
      for (const key of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(key);
    }
  });
});

describe("resolvePath", () => {
  it("allows paths inside the project", () => {
    expect(resolvePath(project, "src/a.ts")).toBe(resolve(project, "src/a.ts"));
    expect(resolvePath(project, join(project, "b.ts"))).toBe(join(project, "b.ts"));
    expect(resolvePath(project, "./x/../y.ts")).toBe(resolve(project, "y.ts"));
  });

  it("refuses paths outside the project", () => {
    expect(() => resolvePath(project, "../secret.txt")).toThrow(/outside the project/);
    expect(() => resolvePath(project, "a/../../secret.txt")).toThrow(/outside the project/);
    expect(() => resolvePath(project, resolve(project, "..", "elsewhere.txt"))).toThrow(/outside the project/);
  });
});

describe("read tool", () => {
  it("reads a whole file", async () => {
    writeFileSync(join(project, "a.txt"), "one\ntwo\nthree");
    expect(await readTool.execute({ path: "a.txt" }, ctx)).toBe("one\ntwo\nthree");
  });

  it("reads part of a file with offset and limit, and says how much is left", async () => {
    writeFileSync(join(project, "a.txt"), "1\n2\n3\n4\n5");
    expect(await readTool.execute({ path: "a.txt", offset: 2, limit: 2 }, ctx)).toBe(
      "2\n3\n\n[2 more lines. Call read again with offset=4]",
    );
  });

  it("fails for a missing file or a path outside the project", async () => {
    await expect(readTool.execute({ path: "missing.txt" }, ctx)).rejects.toThrow(/ENOENT/);
    await expect(readTool.execute({ path: "../x.txt" }, ctx)).rejects.toThrow(/outside the project/);
  });
});

describe("write tool", () => {
  it("creates a file, including missing folders", async () => {
    const out = await writeTool.execute({ path: "deep/dir/new.txt", content: "hello" }, ctx);
    expect(out).toBe("Wrote 5 characters to deep/dir/new.txt");
    expect(readFileSync(join(project, "deep/dir/new.txt"), "utf8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    writeFileSync(join(project, "a.txt"), "old");
    await writeTool.execute({ path: "a.txt", content: "new" }, ctx);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("new");
  });

  it("refuses to write outside the project", async () => {
    // a unique name, removed afterwards even if the check is broken and the file gets written
    const name = `evil-${process.pid}-${Date.now()}.txt`;
    const outside = resolve(project, "..", name);
    try {
      await expect(writeTool.execute({ path: `../${name}`, content: "x" }, ctx)).rejects.toThrow(/outside the project/);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("edit tool", () => {
  it("edits a file on disk", async () => {
    writeFileSync(join(project, "a.ts"), "const x = 1;\nconst y = 2;\n");
    expect(await editTool.execute({ path: "a.ts", old_string: "const y = 2;", new_string: "const y = 3;" }, ctx)).toBe("Edited a.ts");
    expect(readFileSync(join(project, "a.ts"), "utf8")).toBe("const x = 1;\nconst y = 3;\n");
  });

  it("keeps Windows line endings in the saved file", async () => {
    writeFileSync(join(project, "w.txt"), "a\r\nb\r\n");
    await editTool.execute({ path: "w.txt", old_string: "b", new_string: "c" }, ctx);
    expect(readFileSync(join(project, "w.txt"), "utf8")).toBe("a\r\nc\r\n");
  });

  it("leaves the file unchanged when the text isn't found", async () => {
    writeFileSync(join(project, "a.txt"), "abc");
    await expect(editTool.execute({ path: "a.txt", old_string: "zzz", new_string: "y" }, ctx)).rejects.toThrow(/not found/);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("abc");
  });
});

describe("shell", () => {
  const original = process.env.OHM_SHELL;
  afterEach(() => {
    if (original === undefined) delete process.env.OHM_SHELL;
    else process.env.OHM_SHELL = original;
  });

  it("uses OHM_SHELL when it is set", () => {
    process.env.OHM_SHELL = "/custom/bash";
    const shell = getShell();
    expect(shell.command).toBe("/custom/bash");
    expect(shell.args("ls")).toEqual(["-c", "ls"]);
  });

  it("picks bash (or PowerShell on Windows without Git Bash)", () => {
    delete process.env.OHM_SHELL;
    const shell = getShell();
    if (shell.name === "powershell") expect(shell.args("ls")).toEqual(["-NoProfile", "-Command", "ls"]);
    else expect(shell.args("ls")).toEqual(["-c", "ls"]);
  });
});

describe("bash tool", () => {
  it("asks first, and does nothing when the user says no", async () => {
    const confirm = vi.fn(async () => false);
    const out = await bashTool.execute({ command: "echo should-not-run > ran.txt" }, { ...ctx, confirm });
    expect(confirm).toHaveBeenCalledWith("Run: echo should-not-run > ran.txt");
    expect(out).toMatch(/User denied/);
    expect(existsSync(join(project, "ran.txt"))).toBe(false);
  });

  // The tests below run a real shell (Git Bash on Windows when installed).
  const isPowerShell = getShell().name === "powershell";

  it.skipIf(isPowerShell)("runs a command and returns the exit code and output", async () => {
    expect(await bashTool.execute({ command: "echo hello" }, ctx)).toBe("exit code: 0\nhello\n");
  });

  it.skipIf(isPowerShell)("reports a failing exit code and stderr", async () => {
    const out = await bashTool.execute({ command: "echo oops >&2; exit 3" }, ctx);
    expect(out).toBe("exit code: 3\noops\n");
  });

  it.skipIf(isPowerShell)("runs in the project folder", async () => {
    writeFileSync(join(project, "marker.txt"), "found me");
    expect(await bashTool.execute({ command: "cat marker.txt" }, ctx)).toBe("exit code: 0\nfound me");
  });

  it.skipIf(isPowerShell)(
    "stops a command that runs longer than its timeout",
    async () => {
      const out = await bashTool.execute({ command: "sleep 3", timeout: 1 }, ctx);
      expect(out).toContain("[killed after 1s]");
    },
    15_000,
  );
});
