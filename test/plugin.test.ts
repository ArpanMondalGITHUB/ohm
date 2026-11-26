import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the home folder at a temp folder, so your real ~/.ohm/tools plugins aren't loaded.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const { join } = await import("node:path");
  const home = join(os.tmpdir(), `ohm-test-home-plugin-${process.pid}`);
  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPluginTools } from "../src/plugin.ts";
import { makeTempDir, removeDir } from "./helpers.ts";

let project: string;
const projectTools = () => join(project, ".ohm", "tools");
const homeTools = () => join(homedir(), ".ohm", "tools");

function plugin(dir: string, file: string, code: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), code);
}

const nowTool = (name: string) => `
export default {
  name: "${name}",
  description: "Get the time",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() { return "it is ${name} o'clock"; },
};
`;

beforeEach(() => {
  if (!homedir().includes("ohm-test-home-plugin")) throw new Error("refusing to use the real home folder");
  rmSync(homedir(), { recursive: true, force: true });
  project = makeTempDir("ohm-plugin-");
});
afterEach(() => {
  removeDir(project);
  vi.restoreAllMocks();
});
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

describe("loadPluginTools", () => {
  it("returns nothing when there are no plugin folders", async () => {
    expect(await loadPluginTools(project)).toEqual([]);
  });

  it("loads a TypeScript plugin from the project's .ohm/tools", async () => {
    plugin(projectTools(), "now.ts", `const label: string = "typed";\n${nowTool("project_now")}`);
    const tools = await loadPluginTools(project);
    expect(tools.map((t) => t.name)).toEqual(["project_now"]);
    expect(await tools[0].execute({}, { cwd: project, confirm: async () => true })).toBe("it is project_now o'clock");
  });

  it("loads plugins from the home folder and the project, home first", async () => {
    plugin(homeTools(), "a.mjs", nowTool("home_tool"));
    plugin(projectTools(), "b.js", nowTool("project_tool"));
    expect((await loadPluginTools(project)).map((t) => t.name)).toEqual(["home_tool", "project_tool"]);
  });

  it("ignores files that aren't .ts, .js or .mjs", async () => {
    plugin(projectTools(), "README.md", "# notes");
    plugin(projectTools(), "data.json", "{}");
    expect(await loadPluginTools(project)).toEqual([]);
  });

  it("skips a file whose default export isn't a tool, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    plugin(projectTools(), "bad.mjs", `export default { name: "missing-execute" };`);
    plugin(projectTools(), "good.mjs", nowTool("good"));
    expect((await loadPluginTools(project)).map((t) => t.name)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Skipping .*bad\.mjs: default export is not a valid tool/));
  });

  it("keeps going when a plugin fails to load, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    plugin(projectTools(), "broken.mjs", `throw new Error("plugin exploded");`);
    plugin(projectTools(), "ok.mjs", nowTool("ok"));
    expect((await loadPluginTools(project)).map((t) => t.name)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to load plugin .*broken\.mjs: plugin exploded/));
  });
});
