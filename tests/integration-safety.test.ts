import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import { describe, expect, it } from "vitest";

import { parseConfigurationOptions } from "#src/config-options.ts";
import { loadAll } from "#src/loader.ts";
import { parseOptions } from "#src/options.ts";
import { registerCompatibility } from "#src/runtime/compatibility.ts";

import { makeTree } from "./fixture.ts";

const unexpected = (value: unknown) => {
  throw new Error(JSON.stringify(value));
};

describe("integration safety boundaries", () => {
  it("rejects malformed supplied configuration rather than using defaults", () => {
    expect(() => parseConfigurationOptions({ p: { variables: 42 } }, unexpected)).toThrow(
      "configuration maps must be objects",
    );
    expect(() =>
      parseConfigurationOptions({ p: { modelAliases: ["sonnet"] } }, unexpected),
    ).toThrow("modelAliases must map strings");
  });

  it("rejects secrets in rules and model-visible descriptions", async () => {
    const root = await makeTree({
      ".cursor-plugin/plugin.json": JSON.stringify({
        name: "secret",
        variables: { properties: { TOKEN: { type: "string" } }, type: "object" },
      }),
      "rules/secret.mdc": "---\nalwaysApply: true\n---\nsensitive-marker",
      "skills/secret/SKILL.md": "---\ndescription: sensitive-marker\n---\nSafe body.",
    });
    const result = await loadAll([root], {
      configuration: { secret: { variables: { TOKEN: { env: "TOKEN" } } } },
      dataRoot: path.join(root, "data"),
      env: { TOKEN: "sensitive-marker" },
    });
    expect(result.plugins).toEqual([]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("sensitive-marker");
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it.each([false, true])("cleans every registration when prompt setup fails=%s", async (fails) => {
    let acquired = 0;
    let disposed = 0;
    const register = async () => {
      await Promise.resolve();
      acquired += 1;
      return {
        dispose: async () => {
          await Promise.resolve();
          disposed += 1;
        },
      };
    };
    const fake = {
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await Promise.resolve();
          if (!signal.aborted) {
            yield* [];
          }
        },
      },
      location: { directory: "/tmp/opencode", project: { directory: "/tmp/opencode" } },
      session: {
        hook: async (name: string) => {
          if (fails && name === "prompt") {
            throw new Error("prompt registration failed");
          }
          return register();
        },
      },
      tool: { hook: register },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the used native registration surfaces are mocked
    const ctx = fake as unknown as Plugin.Context;
    const options = parseOptions(
      { dataHome: "/data", home: "/home", project: "/project", raw: {} },
      unexpected,
    );
    if (fails) {
      await expect(
        registerCompatibility(ctx, options, () => ({ diagnostics: [], plugins: [] }), unexpected),
      ).rejects.toThrow("prompt registration failed");
    } else {
      const runtime = await registerCompatibility(
        ctx,
        options,
        () => ({ diagnostics: [], plugins: [] }),
        unexpected,
      );
      await runtime.dispose();
    }
    expect(disposed).toBe(acquired);
  });
});
