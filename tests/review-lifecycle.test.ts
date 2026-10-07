import type { Plugin } from "@opencode/plugin";
import { describe, expect, it, vi } from "vitest";

import { parseOptions } from "#src/options.ts";
import { setupCompatibilityLifecycle } from "#src/runtime/compatibility-lifecycle.ts";
import { defaultStyle } from "#src/runtime/default-style.ts";
import type { AgentPlugin, LoadResult } from "#src/types.ts";

const options = (raw: Readonly<Record<string, unknown>>) =>
  parseOptions({ dataHome: "/data", home: "/home", project: "/project", raw }, (entry) => {
    throw new Error(entry.message);
  });
const plugin = (name: string): AgentPlugin => ({
  agents: [],
  commands: [],
  dataDir: "/data",
  format: "claude",
  manifest: { name },
  root: "/plugin",
  rules: [],
  servers: {},
  skills: [],
  styles: [
    {
      content: "Concise.",
      forceForPlugin: false,
      keepCodingInstructions: true,
      name: "concise",
      path: "/style",
    },
  ],
});
const result = (...names: readonly string[]): LoadResult => ({
  diagnostics: [],
  plugins: names.map((name) => plugin(name)),
});

const dispose = async () => {
  await Promise.resolve();
};

describe("reviewed style lifecycle", () => {
  it("counts only active plugins when resolving default selections", () => {
    const settings = options({
      plugins: {
        absent: { components: { styles: { selected: "concise" } } },
        installed: { components: { styles: { selected: "concise" } } },
      },
    });
    expect(defaultStyle(settings, result("installed"))).toEqual({
      name: "concise",
      plugin: "installed",
    });
  });

  it("ignores retained defaults for disabled styles", () => {
    expect(
      defaultStyle(
        options({ components: { styles: { enabled: false, selected: "p:concise" } } }),
        result("p"),
      ),
    ).toBeUndefined();
  });

  it("rejects competing active defaults during setup", async () => {
    const settings = options({
      plugins: {
        first: { components: { styles: { selected: "concise" } } },
        second: { components: { styles: { selected: "concise" } } },
      },
    });
    const ctx = {
      event: {
        async *subscribe() {
          await Promise.resolve();
          yield* [];
        },
      },
      session: {
        hook: async () => {
          await Promise.resolve();
          throw new Error("must not register prompt");
        },
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial native hook surface used in lifecycle test
    const native = ctx as unknown as Plugin.Context;
    await expect(
      setupCompatibilityLifecycle(
        native,
        settings,
        new Set(),
        {
          clearSession: vi.fn<() => void>(),
          dispose,
          replace: vi.fn<() => void>(),
          select: vi.fn<() => void>(),
        },
        { clearSession: vi.fn<() => void>(), dispose, replace: vi.fn<() => void>() },
        () => result("first", "second"),
        () => new Map(),
        vi.fn<() => void>(),
      ),
    ).rejects.toThrow("Only one active plugin");
  });

  it("never marks a session initialised when selection fails", async () => {
    let prompt: ((event: { sessionID: string }) => void) | undefined;
    const ctx = {
      event: {
        async *subscribe() {
          await Promise.resolve();
          yield* [];
        },
      },
      session: {
        hook: async (_name: string, handler: (event: { sessionID: string }) => void) => {
          await Promise.resolve();
          prompt = handler;
          return { dispose };
        },
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal native lifecycle test interface
    const native = ctx as unknown as Plugin.Context;
    const selection = vi.fn<() => void>(() => {
      throw new Error("selection failed");
    });
    const scoped = new Set<string>();
    const runtime = {
      clearSession: vi.fn<() => void>(),
      dispose,
      replace: vi.fn<() => void>(),
      select: selection,
    };
    const cleanup = await setupCompatibilityLifecycle(
      native,
      options({}),
      scoped,
      runtime,
      runtime,
      () => result(),
      () => new Map(),
      vi.fn<() => void>(),
    );
    expect(() => prompt?.({ sessionID: "s" })).toThrow("selection failed");
    expect(() => prompt?.({ sessionID: "s" })).toThrow("selection failed");
    expect(scoped.has("s")).toBe(false);
    expect(selection).toHaveBeenCalledTimes(2);
    await cleanup();
  });
});
