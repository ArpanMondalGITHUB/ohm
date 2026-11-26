import { readFile } from "node:fs/promises";
import { resolvePath } from "./paths.ts";
import type { Tool } from "../types.ts";

const MAX_LINES = 2000;

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file from the project. For big files, use offset (1-based line number) and limit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project folder" },
      offset: { type: "number", description: "First line to read (default 1)" },
      limit: { type: "number", description: `Max lines to read (default ${MAX_LINES})` },
    },
    required: ["path"],
  },

  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    const lines = (await readFile(file, "utf8")).split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Number(args.limit ?? MAX_LINES);

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const remaining = lines.length - (offset - 1 + slice.length);
    const note = remaining > 0
      ? `\n\n[${remaining} more lines. Call read again with offset=${offset + slice.length}]`
      : "";
    return slice.join("\n") + note;
  },
};
