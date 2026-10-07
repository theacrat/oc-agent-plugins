import { describe, expect, it } from "vitest";

import { parseOptions } from "#src/options.ts";
import type { Diagnostic } from "#src/types.ts";

const parse = (raw: Readonly<Record<string, unknown>>) => {
  const diagnostics: Diagnostic[] = [];
  const options = parseOptions(
    { dataHome: "/data", home: "/home/u", project: "/project", raw },
    (entry) => {
      diagnostics.push(entry);
    },
  );
  return { diagnostics, options };
};

describe("grouped public settings", () => {
  it("keeps feature behaviour together and plugin-specific settings under their owner", () => {
    const { diagnostics, options } = parse({
      commands: { enabled: true, shellInjection: false },
      discovery: { paths: ["~/plugins"], vendorDirs: true },
      formats: { cursor: false },
      plugins: {
        example: {
          agents: { modelAliases: { sonnet: "anthropic/claude-sonnet-4-5" } },
          configuration: {
            publicVariables: ["TENANT"],
            userConfig: { token: { env: "TOKEN" } },
            variables: { TENANT: "public" },
          },
          enabled: true,
          hooks: { trusted: true },
          mcp: { appEndpoints: { app_example: { url: "https://example.com/mcp" } } },
          monitors: { trusted: false },
        },
        unwanted: { enabled: false },
      },
      rules: { enabled: false },
      storage: { dataDir: "./plugin-data" },
      styles: { allowSystemReplacement: false, selected: "example:concise" },
    });
    expect(diagnostics).toEqual([]);
    expect(options.searchPaths).toEqual([
      "/home/u/.agents/plugins",
      "/project/.agents/plugins",
      "/home/u/.claude/plugins/marketplaces",
      "/home/u/plugins",
    ]);
    expect(options.dataRoot).toBe("/project/plugin-data");
    expect(options.formats.has("cursor")).toBe(false);
    expect(options.components.has("rules")).toBe(false);
    expect(options.shellInjection).toBe(false);
    expect(options.outputStyle).toBe("example:concise");
    expect(options.trustedHooks).toEqual(["example"]);
    expect(options.trustedMonitors).toEqual([]);
    expect(options.pluginSettings).toEqual({ example: true, unwanted: false });
    expect(options.pluginAppEndpoints).toEqual({
      example: { app_example: { url: "https://example.com/mcp" } },
      unwanted: {},
    });
    expect(options.configuration["example"]).toEqual({
      modelAliases: { sonnet: "anthropic/claude-sonnet-4-5" },
      publicVariables: ["TENANT"],
      userConfig: { token: { env: "TOKEN" } },
      variables: { TENANT: "public" },
    });
  });

  it.each([
    { hooks: false },
    { plugins: { p: { hooks: { trusted: "yes" } } } },
    { discovery: { vendorDirs: "true" } },
    { styles: { selected: false } },
    { discovery: { paths: "./plugins" } },
    { storage: { dataDir: 12 } },
    { plugins: { p: false } },
  ])("rejects malformed groups and trust values %j", (raw) => {
    expect(() => parse(raw)).toThrow();
  });

  it("reports unknown fields at their full nested path", () => {
    const { diagnostics } = parse({
      commands: { typo: true },
      plugins: { p: { hooks: { trust: true } } },
    });
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      'unknown option "plugins.p.hooks.trust"',
      'unknown option "commands.typo"',
    ]);
  });

  it("keeps identical app IDs isolated between plugins", () => {
    const { options } = parse({
      plugins: {
        first: { mcp: { appEndpoints: { app: { url: "https://first.example.com/mcp" } } } },
        second: { mcp: { appEndpoints: { app: { url: "https://second.example.com/mcp" } } } },
      },
    });
    expect(options.pluginAppEndpoints).toEqual({
      first: { app: { url: "https://first.example.com/mcp" } },
      second: { app: { url: "https://second.example.com/mcp" } },
    });
  });

  it("migrates old settings without silently losing trust", () => {
    const { diagnostics, options } = parse({
      paths: ["./plugins"],
      shellInjection: false,
      trustedHooks: ["p"],
    });
    expect(options.trustedHooks).toEqual(["p"]);
    expect(options.shellInjection).toBe(false);
    expect(diagnostics[0]?.message).toContain("deprecated");
    expect(() =>
      parse({ plugins: { p: { hooks: { trusted: true } } }, trustedHooks: ["p"] }),
    ).toThrow("Do not mix");
  });
});
