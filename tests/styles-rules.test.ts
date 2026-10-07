import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import { describe, expect, it, vi } from "vitest";

import { filesForTool, registerScopedRules, ruleMatchesFile } from "#src/runtime/rules.ts";
import { registerOutputStyles } from "#src/runtime/styles.ts";
import type { PluginRule } from "#src/types.ts";
import { loadOutputStyles } from "#src/vendor/output-styles.ts";
import type { PluginOutputStyle } from "#src/vendor/output-styles.ts";

interface ContextEvent {
  sessionID: string;
  system: { type: "text"; text: string }[];
}
interface ToolEvent {
  sessionID: string;
  tool: string;
  input: unknown;
}
const nativeHooks = () => {
  let context = vi.fn<(event: ContextEvent) => void>();
  let before = vi.fn<(event: ToolEvent) => void>();
  const disposeContext = vi.fn(async () => {
    await Promise.resolve();
  });
  const disposeTool = vi.fn(async () => {
    await Promise.resolve();
  });
  const mock = {
    session: {
      hook: vi.fn(async (name: string, handler: (event: ContextEvent) => void) => {
        await Promise.resolve();
        expect(name).toBe("context");
        context = vi.fn(handler);
        return { dispose: disposeContext };
      }),
    },
    tool: {
      hook: vi.fn(async (name: string, handler: (event: ToolEvent) => void) => {
        await Promise.resolve();
        expect(name).toBe("execute.before");
        before = vi.fn(handler);
        return { dispose: disposeTool };
      }),
    },
  };
  // This mock implements only hook registration; production code uses native typedefs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ctx = mock as unknown as Plugin.Context;
  return {
    ctx,
    disposeContext,
    disposeTool,
    model: (sessionID: string) => {
      const event: ContextEvent = {
        sessionID,
        system: [{ text: "Coding instructions", type: "text" }],
      };
      context(event);
      return event.system.map((part) => part.text);
    },
    tool: (sessionID: string, tool: string, input: unknown) => {
      before({ input, sessionID, tool });
    },
  };
};
const style = (name: string, extra: Partial<PluginOutputStyle> = {}): PluginOutputStyle => ({
  content: name,
  forceForPlugin: false,
  keepCodingInstructions: true,
  name,
  path: `/styles/${name}.md`,
  ...extra,
});
const rule = (name: string, globs: readonly string[], alwaysApply = false): PluginRule => ({
  alwaysApply,
  content: name,
  globs,
  name,
  path: `/rules/${name}.mdc`,
});

describe("output styles", () => {
  it("rejects selective coding-instruction removal unless whole-system replacement is opted in", async () => {
    const native = nativeHooks();
    const runtime = await registerOutputStyles(
      native.ctx,
      [{ plugin: "p", styles: [style("writer", { keepCodingInstructions: false })] }],
      { main: { name: "writer", plugin: "p" } },
    );
    expect(() => native.model("main")).toThrow("cannot isolate coding instructions");
    await runtime.dispose();
  });
  it("discovers default and replacing custom directories, parses flags, and expands bodies", async () => {
    const root = await mkdtemp("/tmp/opencode/ap-styles-");
    try {
      await mkdir(path.join(root, "output-styles"));
      await mkdir(path.join(root, "custom"));
      await writeFile(path.join(root, "output-styles", "default.md"), "Default style");
      await writeFile(
        path.join(root, "custom", "chosen.md"),
        "---\nname: Friendly\ndescription: Help kindly\nkeep-coding-instructions: true\nforce-for-plugin: true\n---\nHello TOKEN",
      );
      const defaults = await loadOutputStyles(root, undefined, vi.fn<() => void>());
      expect(defaults.map((entry) => entry.name)).toEqual(["default"]);
      const found = await loadOutputStyles(root, "./custom", vi.fn<() => void>(), (body) =>
        body.replace("TOKEN", "world"),
      );
      expect(found).toEqual([
        {
          content: "Hello world",
          description: "Help kindly",
          forceForPlugin: true,
          keepCodingInstructions: true,
          name: "Friendly",
          path: path.join(root, "custom", "chosen.md"),
        },
      ]);
      await expect(
        loadOutputStyles(root, "./custom", vi.fn<() => void>(), () => {
          throw new Error("sensitive body reference");
        }),
      ).rejects.toThrow("sensitive");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("applies only selected styles to exact sessions and disposes native registrations", async () => {
    const native = nativeHooks();
    const runtime = await registerOutputStyles(
      native.ctx,
      [{ plugin: "p", styles: [style("one"), style("two", { keepCodingInstructions: false })] }],
      { main: { name: "one", plugin: "p" } },
      { allowSystemReplacement: true },
    );
    expect(native.model("main")).toEqual(["Coding instructions", "one"]);
    expect(native.model("child")).toEqual(["Coding instructions"]);
    runtime.select("main", { name: "two", plugin: "p" });
    expect(native.model("main")).toEqual(["two"]);
    expect(() => {
      runtime.select("main", { name: "absent", plugin: "p" });
    }).toThrow("does not exist");
    runtime.replace([{ plugin: "p", styles: [style("two", { content: "reloaded" })] }]);
    expect(native.model("main")).toEqual(["Coding instructions", "reloaded"]);
    runtime.clearSession("main");
    expect(native.model("main")).toEqual(["Coding instructions"]);
    await runtime.dispose();
    await runtime.dispose();
    expect(native.disposeContext).toHaveBeenCalledTimes(1);
    expect(() => {
      runtime.select("main", undefined);
    }).toThrow("disposed");
  });

  it("uses only the first forced style and never leaks forced styles to unscoped subagents", async () => {
    const native = nativeHooks();
    const runtime = await registerOutputStyles(
      native.ctx,
      [
        {
          plugin: "a",
          styles: [
            style("forced", { forceForPlugin: true }),
            style("ignored", { forceForPlugin: true }),
            style("chosen"),
          ],
        },
      ],
      { main: { name: "chosen", plugin: "a" } },
    );
    expect(native.model("main")).toEqual(["Coding instructions", "forced"]);
    expect(native.model("child")).toEqual(["Coding instructions"]);
    await runtime.dispose();
    expect(native.model("main")).toEqual(["Coding instructions"]);
  });
});

describe("scoped Cursor rules", () => {
  it("matches file globs without accepting paths outside the session directory", () => {
    expect(ruleMatchesFile(rule("ts", ["**/*.{ts,tsx}"]), "src/index.ts", "/project")).toBe(true);
    expect(ruleMatchesFile(rule("ts", ["**/*.ts"]), "../other/a.ts", "/project")).toBe(false);
    expect(filesForTool("shell", { command: "cat a.ts", path: "a.ts" })).toEqual([]);
    expect(
      filesForTool("patch", { patchText: "*** Update File: src/a.ts\n*** Move to: src/b.ts" }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("activates file-oriented rules through native hooks with session, reload and unload boundaries", async () => {
    const native = nativeHooks();
    const runtime = await registerScopedRules(native.ctx, "/project", [
      rule("always", [], true),
      rule("typescript", ["**/*.ts"]),
      rule("markdown", ["**/*.md"]),
      rule("manual", []),
    ]);
    expect(native.model("one")).toEqual(["Coding instructions", "always"]);
    native.tool("one", "read", { path: "/project/src/a.ts" });
    expect(native.model("one")).toEqual(["Coding instructions", "always", "typescript"]);
    expect(native.model("two")).toEqual(["Coding instructions", "always"]);
    native.tool("two", "shell", { path: "a.ts" });
    native.tool("two", "read", { path: "/outside/a.ts" });
    expect(native.model("two")).toEqual(["Coding instructions", "always"]);
    runtime.clearSession("one");
    expect(native.model("one")).toEqual(["Coding instructions", "always"]);
    native.tool("one", "write", { filePath: "a.ts" });
    runtime.replace([rule("new", ["**/*.ts"])]);
    expect(native.model("one")).toEqual(["Coding instructions"]);
    native.tool("one", "edit", { filePath: "a.ts" });
    expect(native.model("one")).toEqual(["Coding instructions", "new"]);
    await runtime.dispose();
    await runtime.dispose();
    native.tool("one", "read", { path: "a.ts" });
    expect(native.model("one")).toEqual(["Coding instructions"]);
    expect(native.disposeTool).toHaveBeenCalledTimes(1);
    expect(native.disposeContext).toHaveBeenCalledTimes(1);
  });
});
