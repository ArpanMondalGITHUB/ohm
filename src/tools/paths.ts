import path from "node:path";

/** Resolve a path the model gave us, and refuse anything outside the project. */
export function resolvePath(cwd: string, p: string): string {
  const full = path.resolve(cwd, p);
  const rel = path.relative(cwd, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project folder: ${p}`);
  }
  return full;
}
