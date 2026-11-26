import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import type { Tool } from "../types.ts";

export const builtinTools: Tool[] = [readTool, writeTool, editTool, bashTool];
