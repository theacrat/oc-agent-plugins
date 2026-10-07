import { readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeTempDir, makeTree } from "./fixture.ts";

describe("private temporary fixtures", () => {
  it("creates distinct directories beneath the native temporary directory", async () => {
    const first = await makeTempDir("fixture-test-");
    const second = await makeTempDir("fixture-test-");
    try {
      const parent = await realpath(tmpdir());
      expect(first).not.toBe(second);
      expect(path.basename(first)).toMatch(/^fixture-test-/u);
      expect(path.dirname(first)).toBe(parent);
      const firstInfo = await stat(first);
      const secondInfo = await stat(second);
      expect(firstInfo.isDirectory()).toBe(true);
      expect(secondInfo.isDirectory()).toBe(true);
    } finally {
      await Promise.all(
        [first, second].map(async (root) => rm(root, { force: true, recursive: true })),
      );
    }
  });

  it("keeps identical filenames in separate fixture trees", async () => {
    const first = await makeTree({ "nested/file.txt": "first" });
    const second = await makeTree({ "nested/file.txt": "second" });
    expect(first).not.toBe(second);
    expect(await readFile(path.join(first, "nested", "file.txt"), "utf8")).toBe("first");
    expect(await readFile(path.join(second, "nested", "file.txt"), "utf8")).toBe("second");
  });
});
