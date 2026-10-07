import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { toAgentInfo, toPolicyServerConfigs } from "#src/opencode.ts";

import { makeTree } from "./fixture.ts";

const json = (value: unknown) => JSON.stringify(value);
// oxlint-disable-next-line no-template-curly-in-string -- literal configuration references under test
const TOKEN = "${user_config.token}";
// oxlint-disable-next-line no-template-curly-in-string -- literal configuration references under test
const GREETING = "${user_config.greeting}";

describe("integrated compatibility loading", () => {
  it("resolves public config in prompts and secret config only in MCP transport", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": json({
        name: "config",
        userConfig: {
          greeting: {
            default: "Hello",
            description: "Greeting",
            title: "Greeting",
            type: "string",
          },
          token: {
            description: "Credential",
            required: true,
            sensitive: true,
            title: "Token",
            type: "string",
          },
        },
      }),
      ".mcp.json": json({
        mcpServers: {
          remote: {
            headers: { Authorization: `Bearer ${TOKEN}` },
            oauth: false,
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      }),
      "agents/review.md": "---\nmodel: sonnet\n---\nReview carefully.",
      "output-styles/concise.md": "---\nkeep-coding-instructions: true\n---\nBe concise.",
      "skills/greet/SKILL.md": `---\ndescription: Greet.\n---\n${GREETING}`,
    });
    const result = await loadAll([root], {
      configuration: {
        config: {
          modelAliases: { sonnet: "anthropic/claude-sonnet-4-5" },
          userConfig: { token: { env: "CONFIG_TOKEN" } },
        },
      },
      dataRoot: path.join(root, "data"),
      env: { CONFIG_TOKEN: "secret-credential" },
    });
    expect(result.diagnostics).toEqual([]);
    const [plugin] = result.plugins;
    expect(plugin?.skills[0]?.content).toBe("Hello");
    expect(plugin?.configuration?.values).toEqual({ greeting: "Hello" });
    expect(plugin?.styles?.[0]?.content).toBe("Be concise.");
    if (plugin === undefined) {
      throw new Error("missing plugin");
    }
    expect(toAgentInfo(plugin)[0]?.model).toEqual({
      id: "claude-sonnet-4-5",
      providerID: "anthropic",
    });
    expect(toPolicyServerConfigs(plugin)).toEqual([
      [
        "config-remote",
        {
          headers: { Authorization: "Bearer secret-credential" },
          oauth: false,
          type: "remote",
          url: "https://example.com/mcp",
        },
      ],
    ]);
  });

  it("isolates missing required configuration from independent plugins", async () => {
    const root = await makeTree({
      "bad/.cursor-plugin/plugin.json": json({
        name: "bad",
        variables: {
          properties: { TOKEN: { type: "string" } },
          required: ["TOKEN"],
          type: "object",
        },
      }),
      "good/.claude-plugin/plugin.json": json({ name: "good" }),
      "good/commands/ok.md": "Ready.",
    });
    const result = await loadAll([root], { dataRoot: path.join(root, "data") });
    expect(result.plugins.map((plugin) => plugin.manifest.name)).toEqual(["good"]);
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("preserves disabled vendor MCP definitions", async () => {
    const root = await makeTree({
      ".codex-plugin/plugin.json": json({ name: "safe" }),
      ".mcp.json": json({
        mcpServers: { off: { enabled: false, type: "http", url: "https://example.com/mcp" } },
      }),
    });
    const result = await loadAll([root], { dataRoot: path.join(root, "data") });
    expect(result.plugins[0]?.servers["off"]?.disabled).toBe(true);
  });
});
