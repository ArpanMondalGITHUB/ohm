import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePath } from "./paths.ts";
import type { Tool } from "../types.ts";

export const writeTool: Tool = {
  name: "write",
  description: "Create a new file or completely overwrite an existing one. For small changes, use edit instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project folder" },
      content: { type: "string", description: "The full file content" },
    },
    required: ["path", "content"],
  },

  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    await mkdir(dirname(file), { recursive: true }); // create parent folders if needed
    await writeFile(file, args.content, "utf8");
    return `Wrote ${args.content.length} characters to ${args.path}`;
  },
};
