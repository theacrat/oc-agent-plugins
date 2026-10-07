import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { componentsForPlugin, parseOptions } from "#src/options.ts";

import { makeTree, manifest, skill } from "./fixture.ts";

const secret = "private-review-token-123";
const configuredLoad = async (root: string, raw: Record<string, unknown> = {}) => {
  const options = parseOptions({ dataHome: root, home: root, project: root, raw }, (diagnostic) => {
    expect(diagnostic.severity).not.toBe("error");
  });
  return loadAll([root], {
    appEndpoints: options.appEndpoints,
    components: (name) => componentsForPlugin(options, name),
    configuration: options.configuration,
    dataRoot: options.dataRoot,
    env: { TOKEN: secret },
    formats: options.formats,
    pluginAppEndpoints: options.pluginAppEndpoints,
    pluginSettings: options.pluginSettings,
    trustedHooks: options.trustedHooks,
  });
};
const claude = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "demo", ...extra });
const sensitiveConfig = {
  plugins: { demo: { configuration: { userConfig: { token: { env: "TOKEN" } } } } },
};
const sensitiveManifest = {
  userConfig: {
    token: { description: "Token", sensitive: true, title: "Token", type: "string" },
  },
};

describe("component selection before loading", () => {
  it.each(["keep-coding-instructions", "force-for-plugin"])(
    "isolates malformed %s to its style file",
    async (flag) => {
      const root = await makeTree({
        ".claude-plugin/plugin.json": claude(),
        "output-styles/bad.md": `---\n${flag}: ${secret}\n---\nBad style`,
        "output-styles/good.md": "---\nkeep-coding-instructions: true\n---\nGood style",
        "skills/deploy/SKILL.md": skill("deploy"),
      });
      const result = await configuredLoad(root);
      expect(result.plugins[0]?.skills).toHaveLength(1);
      expect(result.plugins[0]?.styles?.map((style) => style.name)).toEqual(["good"]);
      expect(result.diagnostics).toEqual([
        {
          message: `output style ${flag} must be a boolean`,
          severity: "error",
          source: "demo/output-styles/bad.md",
        },
      ]);
      expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
    },
  );

  it.each([
    { components: { styles: { enabled: false } } },
    {
      plugins: {
        demo: { ...sensitiveConfig.plugins.demo, components: { styles: { enabled: false } } },
      },
    },
  ])("does not parse disabled styles: %j", async (selection) => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude(sensitiveManifest),
      "output-styles/bad.md": "---\nforce-for-plugin: nope\n---\nBody",
      "output-styles/private.md": `\${user_config.token}`,
      "skills/deploy/SKILL.md": skill("deploy"),
    });
    const result = await configuredLoad(root, { ...sensitiveConfig, ...selection });
    expect(result.plugins[0]?.skills).toHaveLength(1);
    expect(result.plugins[0]?.styles).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("allows a plugin override to enable a globally disabled style parser", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude(sensitiveManifest),
      "output-styles/good.md": "Public body",
      "output-styles/literal.md": secret,
      "output-styles/private.md": `\${user_config.token}`,
      "skills/deploy/SKILL.md": skill("deploy"),
    });
    const result = await configuredLoad(root, {
      ...sensitiveConfig,
      components: { styles: { enabled: false } },
      plugins: {
        demo: { ...sensitiveConfig.plugins.demo, components: { styles: { enabled: true } } },
      },
    });
    expect(result.plugins[0]?.skills).toHaveLength(1);
    expect(result.plugins[0]?.styles?.map((style) => style.name)).toEqual(["good"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(
      result.diagnostics.every(
        (entry) => entry.message === "output style body configuration expansion failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("skips disabled vendor parsers, app mappings and extras", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude({
        agents: `\${user_config.unknown}`,
        apps: { private: { url: secret } },
        commands: `\${user_config.unknown}`,
        hooks: "missing.json",
        lspServers: { bad: { command: `\${user_config.unknown}` } },
        mcpServers: { bad: { command: `\${user_config.unknown}` } },
        monitors: "missing.json",
        outputStyles: "missing.md",
        rules: "missing.md",
      }),
      "skills/deploy/SKILL.md": skill("deploy"),
    });
    const result = await configuredLoad(root, {
      components: {
        agents: false,
        commands: { enabled: false },
        hooks: false,
        lsp: false,
        mcp: false,
        monitors: false,
        rules: false,
        styles: { enabled: false },
      },
    });
    expect(result.plugins[0]?.skills).toHaveLength(1);
    expect(result.plugins[0]?.servers).toEqual({});
    expect(result.plugins[0]?.hooks).toEqual([]);
    expect(result.plugins[0]?.runtimes?.monitors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("skips portable skills and MCP parsers independently", async () => {
    const root = await makeTree({
      "mcp.json": "not json",
      "plugin.json": manifest(),
      "skills/bad/SKILL.md": "not frontmatter",
    });
    const disabled = await configuredLoad(root, { components: { mcp: false, skills: false } });
    expect(disabled.plugins[0]?.skills).toEqual([]);
    expect(disabled.plugins[0]?.servers).toEqual({});
    expect(disabled.diagnostics).toEqual([]);
    const defaults = await loadAll([root], { dataRoot: path.join(root, "data") });
    expect(defaults.diagnostics).toHaveLength(2);
  });

  it("still validates required plugin configuration with components disabled", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude({
        userConfig: {
          required: { description: "Required", required: true, title: "Required", type: "string" },
        },
      }),
    });
    const result = await configuredLoad(root, { components: { styles: { enabled: false } } });
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("keeps enabled MCP validation fail-closed for unsupported security fields", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude({
        mcpServers: {
          bad: { command: "node", unrecognisedSecurityPolicy: { allow: true } },
          good: { command: "node" },
        },
      }),
      "skills/deploy/SKILL.md": skill("deploy"),
    });
    const result = await configuredLoad(root);
    expect(result.plugins[0]?.skills).toHaveLength(1);
    expect(Object.keys(result.plugins[0]?.servers ?? {})).toEqual(["good"]);
    expect(result.diagnostics).toHaveLength(1);
    const disabled = await loadAll([root], {
      components: new Set(["skills"]),
      dataRoot: path.join(root, "data"),
    });
    expect(disabled.plugins[0]?.servers).toEqual({});
    expect(disabled.diagnostics).toEqual([]);
  });

  it("retains the resolved secret guard on enabled model outputs", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": claude(sensitiveManifest),
      "skills/deploy/SKILL.md": skill("deploy").replace("Body of deploy.", secret),
    });
    const result = await configuredLoad(root, sensitiveConfig);
    expect(result.plugins).toEqual([]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });
});
