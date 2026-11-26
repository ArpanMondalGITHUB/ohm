import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "./types.ts";

function isTool(x: any): x is Tool {
  return (
    x &&
    typeof x.name === "string" &&
    typeof x.description === "string" &&
    typeof x.execute === "function" &&
    x.parameters?.type === "object"
  );
}

/** Load tools from ~/.ohm/tools and <project>/.ohm/tools. Each file `export default`s one tool. */
export async function loadPluginTools(cwd: string): Promise<Tool[]> {
  const dirs = [join(homedir(), ".ohm", "tools"), join(cwd, ".ohm", "tools")];
  const tools: Tool[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f))) {
      const full = join(dir, file);
      try {
        const mod = await import(pathToFileURL(full).href); // file URL is required on Windows
        if (isTool(mod.default)) tools.push(mod.default);
        else console.warn(`Skipping ${full}: default export is not a valid tool`);
      } catch (err) {
        console.warn(`Failed to load plugin ${full}: ${(err as Error).message}`);
      }
    }
  }
  return tools;
}
