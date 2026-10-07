import { describe, expect, it } from "vitest";

import {
  alwaysRules,
  formatStatus,
  scopeComponents,
  toCommands,
  toServerConfigs,
  toSkillInfo,
} from "#src/opencode.ts";
import type { AgentPlugin } from "#src/types.ts";

const plugin: AgentPlugin = {
  agents: [],
  commands: [
    {
      arguments: [],
      description: "Ship it",
      name: "deploy",
      syntax: "plain",
      template: "Deploy $1 to $2.",
    },
  ],
  dataDir: "/data/demo",
  format: "cursor",
  manifest: { name: "demo", version: "1.0.0" },
  root: "/plugins/demo",
  rules: [
    {
      alwaysApply: true,
      content: "Always use const.",
      globs: [],
      name: "const",
      path: "/plugins/demo/rules/const.mdc",
    },
    {
      alwaysApply: false,
      content: "Prefer named exports.",
      description: "Export style",
      globs: ["**/*.ts"],
      name: "exports",
      path: "/plugins/demo/rules/exports.mdc",
    },
  ],
  servers: {
    local: {
      args: ["--x"],
      command: "/plugins/demo/bin/s",
      cwd: "/plugins/demo",
      env: { PLUGIN_ROOT: "/plugins/demo" },
      type: "stdio",
    },
    remote: { headers: { "X-A": "1" }, type: "streamable-http", url: "https://example.com/mcp" },
  },
  skills: [
    {
      content: "Body",
      description: "Does things.",
      name: "deploy",
      path: "/plugins/demo/skills/deploy/SKILL.md",
    },
  ],
};

describe("opencode mapping", () => {
  it("distinguishes displayed skill names from different plugins without changing source content", () => {
    const other = { ...plugin, manifest: { ...plugin.manifest, name: "other" } };
    const [first] = toSkillInfo(plugin);
    const [second] = toSkillInfo(other);
    expect(first?.name).toBe("demo:deploy");
    expect(second?.name).toBe("other:deploy");
    expect(first?.content).toBe("Body");
    expect(second?.content).toBe("Body");
    expect(plugin.skills[0]?.name).toBe("deploy");
  });
  it("namespaces skills and turns non-always rules into skills", () => {
    expect(toSkillInfo(plugin)).toEqual([
      {
        content: "Body",
        description: "Does things.",
        id: "demo:deploy",
        name: "demo:deploy",
        path: "/plugins/demo/skills/deploy/SKILL.md",
      },
      {
        content: "Prefer named exports.",
        description: "Export style (applies to **/*.ts)",
        id: "demo:rule-exports",
        name: "demo:rule-exports",
        path: "/plugins/demo/rules/exports.mdc",
      },
    ]);
  });

  it("puts always-apply rules in the system prompt", () => {
    expect(alwaysRules(plugin)).toEqual([
      '<rule plugin="demo" name="const">\nAlways use const.\n</rule>',
    ]);
  });

  it("drops disabled component types", () => {
    const scoped = scopeComponents(plugin, new Set(["skills", "mcp"]));
    expect([
      scoped.commands,
      scoped.rules,
      Object.keys(scoped.servers),
      scoped.skills.length,
    ]).toEqual([[], [], ["local", "remote"], 1]);
  });

  it("namespaces commands", () => {
    expect(toCommands(plugin).map(({ name }) => name)).toEqual(["demo:deploy"]);
  });

  it("maps servers to opencode local and remote configs", () => {
    expect(toServerConfigs(plugin)).toEqual([
      [
        "demo-local",
        {
          command: ["/plugins/demo/bin/s", "--x"],
          cwd: "/plugins/demo",
          environment: { PLUGIN_ROOT: "/plugins/demo" },
          type: "local",
        },
      ],
      ["demo-remote", { headers: { "X-A": "1" }, type: "remote", url: "https://example.com/mcp" }],
    ]);
  });

  it("formats a status report", () => {
    const text = formatStatus(
      {
        diagnostics: [{ message: "bad", severity: "error", source: "demo/mcp.json#x" }],
        plugins: [plugin],
      },
      ["/p"],
    );
    expect(text).toBe(
      [
        "Agent Plugins searched: /p",
        "",
        "demo@1.0.0 [cursor] (/plugins/demo)",
        "  skills: demo:deploy, demo:rule-exports",
        "  mcp: demo-local, demo-remote",
        "  commands: /demo:deploy",
        "  always-on rules: const",
        "",
        "Diagnostics:",
        "- error: demo/mcp.json#x: bad",
      ].join("\n"),
    );
  });
});
