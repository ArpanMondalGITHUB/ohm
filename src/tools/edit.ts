import { readFile, writeFile } from "node:fs/promises";
import { resolvePath } from "./paths.ts";
import type { Tool } from "../types.ts";

/**
 * Replace exactly one occurrence of oldString. Kept separate from the tool so it's easy to test.
 * Handles Windows (\r\n) files: the model always writes \n, so we normalize, edit, then restore.
 */
export function applyEdit(text: string, oldString: string, newString: string): string {
  const crlf = text.includes("\r\n");
  const normalized = crlf ? text.replace(/\r\n/g, "\n") : text;
  const oldN = oldString.replace(/\r\n/g, "\n");
  const newN = newString.replace(/\r\n/g, "\n");

  if (oldN === "") throw new Error("old_string must not be empty. Use the write tool to create files.");

  const count = normalized.split(oldN).length - 1;
  if (count === 0) {
    throw new Error("old_string not found in the file. Read the file again and copy the exact text, including spaces and indentation.");
  }
  if (count > 1) {
    throw new Error(`old_string was found ${count} times. Include more surrounding lines so it matches exactly once.`);
  }

  const index = normalized.indexOf(oldN);
  const result = normalized.slice(0, index) + newN + normalized.slice(index + oldN.length);
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by replacing an exact piece of text. old_string must match the file exactly (including indentation) and appear exactly once. Read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project folder" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Text to put in its place" },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(args, ctx) {
    const file = resolvePath(ctx.cwd, args.path);
    const text = await readFile(file, "utf8");
    await writeFile(file, applyEdit(text, args.old_string, args.new_string), "utf8");
    return `Edited ${args.path}`;
  },
};
