import { describe, expect, it } from "vitest";

import { parseJson } from "#src/json.ts";
import { commandInjectionForPlugin, componentsForPlugin, parseOptions } from "#src/options.ts";
import { normaliseSettings } from "#src/settings-layout.ts";
import { COMPONENTS } from "#src/types.ts";
import type { Diagnostic } from "#src/types.ts";

const jsonNull = parseJson("null");
const nullValue = jsonNull.ok ? jsonNull.value : undefined;

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

describe("review settings regressions", () => {
  it.each(["false", 0, nullValue, {}, []])("rejects a malformed format flag %j", (claude) => {
    expect(() => parse({ formats: { claude } })).toThrow("formats.claude must be true or false");
  });

  it.each(["false", nullValue, []])("rejects a malformed formats group %j", (formats) => {
    expect(() => parse({ formats })).toThrow("formats must be an object");
  });

  it.each([
    { url: "http://remote.example/mcp" },
    { url: "https://user:secret@example.com/mcp" },
    { url: "https://example.com/mcp#fragment" },
    { url: 12 },
    { headers: { Authorization: false }, url: "https://example.com/mcp" },
    { headers: { Authorization: "a\nb" }, url: "https://example.com/mcp" },
    { headers: { Authorization: "a", authorization: "b" }, url: "https://example.com/mcp" },
    false,
    nullValue,
  ])("rejects invalid endpoints with the owning plugin and app path %j", (endpoint) => {
    expect(() => parse({ plugins: { p: { mcp: { appEndpoints: { app: endpoint } } } } })).toThrow(
      "plugins.p.mcp.appEndpoints.app",
    );
  });

  it("reports unknown endpoint fields without copying them or sharing endpoints", () => {
    const { diagnostics, options } = parse({
      plugins: {
        p: { mcp: { appEndpoints: { app: { typo: true, url: "https://p.example/mcp" } } } },
        q: { mcp: { appEndpoints: { app: { url: "https://q.example/mcp" } } } },
      },
    });
    expect(diagnostics).toEqual([
      {
        message: 'unknown option "plugins.p.mcp.appEndpoints.app.typo"',
        severity: "warning",
        source: "options",
      },
    ]);
    expect(options.pluginAppEndpoints).toEqual({
      p: { app: { url: "https://p.example/mcp" } },
      q: { app: { url: "https://q.example/mcp" } },
    });
    expect(options.appEndpoints).toEqual({});
  });

  it.each([{ sonnet: "attacker/model" }, "bad", nullValue])(
    "drops unknown configuration.modelAliases rather than validating or applying it %j",
    (modelAliases) => {
      const { diagnostics, options } = parse({
        plugins: {
          p: {
            agents: { modelAliases: { sonnet: "trusted/model" } },
            configuration: { modelAliases },
          },
          q: { configuration: { modelAliases } },
        },
      });
      expect(diagnostics.map((entry) => entry.message)).toEqual([
        'unknown option "plugins.p.configuration.modelAliases"',
        'unknown option "plugins.q.configuration.modelAliases"',
      ]);
      expect(options.configuration["p"]?.modelAliases).toEqual({ sonnet: "trusted/model" });
      expect(options.configuration["q"]?.modelAliases).toBeUndefined();
    },
  );

  it("does not grant trust through unknown fields at any ownership level", () => {
    const { options, diagnostics } = parse({
      plugins: {
        p: {
          configuration: { trustedHooks: true, trustedMonitors: true },
          hooks: { trust: true },
          monitors: { trust: true },
          trustedMonitors: true,
        },
      },
      trustedHooks: ["p"],
    });
    expect(options.trustedHooks).toEqual([]);
    expect(options.trustedMonitors).toEqual([]);
    expect(diagnostics).toHaveLength(6);
    expect(diagnostics.every((entry) => entry.severity === "warning")).toBe(true);
  });

  it.each(["hooks", "monitors"])("rejects malformed %s trust instead of granting it", (feature) => {
    expect(() => parse({ plugins: { p: { [feature]: { trusted: "false" } } } })).toThrow(
      `plugins.p.${feature}.trusted must be true or false`,
    );
  });

  it.each([
    [{ configuration: { userConfig: "invalid" } }, "plugins.p.configuration.userConfig"],
    [{ configuration: { variables: { bad: nullValue } } }, "plugins.p.configuration.variables.bad"],
    [{ configuration: { publicVariables: false } }, "plugins.p.configuration.publicVariables"],
    [{ agents: { modelAliases: false } }, "plugins.p.agents.modelAliases"],
  ])("identifies the owner of invalid configuration %j", (entry, owner) => {
    expect(() => parse({ plugins: { p: entry } })).toThrow(owner);
  });

  it.each(COMPONENTS)("inherits and overrides the %s component independently", (component) => {
    const setting = (enabled: boolean) =>
      component === "commands" || component === "styles" ? { enabled } : enabled;
    const { options } = parse({
      components: { [component]: setting(false) },
      plugins: { p: { components: { [component]: setting(true) } }, q: {} },
    });
    expect(componentsForPlugin(options, "p").has(component)).toBe(true);
    expect(componentsForPlugin(options, "q").has(component)).toBe(false);
    expect(options.componentOverrides["p"]).toEqual({ enabled: { [component]: true } });
  });

  it("preserves exactly the explicit override fields and inherits all omitted defaults", () => {
    const raw = {
      components: {
        agents: false,
        commands: { enabled: false, shellInjection: false },
        styles: { allowSystemReplacement: true, enabled: false, selected: "global:style" },
      },
      plugins: {
        custom: {
          components: {
            agents: true,
            commands: { shellInjection: true },
            styles: { allowSystemReplacement: false, selected: "custom:style" },
          },
        },
        empty: {},
      },
    };
    const { options } = parse(raw);
    expect(options.componentOverrides["empty"]).toEqual({ enabled: {} });
    expect(options.componentOverrides["custom"]).toEqual({
      allowSystemReplacement: false,
      enabled: { agents: true },
      outputStyle: "custom:style",
      shellInjection: true,
    });
    expect([...componentsForPlugin(options, "empty")]).toEqual([...options.components]);
    expect([...componentsForPlugin(options, "custom")]).toEqual(
      COMPONENTS.filter((component) => component === "agents" || options.components.has(component)),
    );
    expect(commandInjectionForPlugin(options, "empty")).toBe(false);
    expect(commandInjectionForPlugin(options, "custom")).toBe(true);
    const normalised = normaliseSettings(raw, (entry) => {
      throw new Error(entry.message);
    });
    expect(normalised).not.toHaveProperty("enabled");
    expect(normalised.componentOverrides).toEqual(options.componentOverrides);
  });
});
