import { describe, expect, it } from "vitest";
import { applyEdit } from "../src/tools/edit.ts";

describe("applyEdit", () => {
  it("replaces exactly one match", () => {
    expect(applyEdit("a\nb\nc", "b", "B")).toBe("a\nB\nc");
  });

  it("can replace text with nothing (delete it)", () => {
    expect(applyEdit("keep remove keep", " remove", "")).toBe("keep keep");
  });

  it("fails when the text is not found", () => {
    expect(() => applyEdit("abc", "x", "y")).toThrow(/not found/);
  });

  it("fails when the text is found more than once", () => {
    expect(() => applyEdit("a a", "a", "b")).toThrow(/2 times/);
  });

  it("fails when old_string is empty", () => {
    expect(() => applyEdit("abc", "", "x")).toThrow(/must not be empty/);
  });

  it("keeps Windows line endings", () => {
    expect(applyEdit("a\r\nb\r\n", "a\nb", "x\ny")).toBe("x\r\ny\r\n");
  });

  it("accepts \\r\\n in old_string for a \\n file", () => {
    expect(applyEdit("a\nb\n", "a\r\nb", "z")).toBe("z\n");
  });

  it("does not treat $ as a special pattern", () => {
    expect(applyEdit("x", "x", "$&")).toBe("$&");
  });
});
