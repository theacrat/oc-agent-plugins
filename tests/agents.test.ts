import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { scopeComponents, toAgentInfo } from "#src/opencode.ts";
import { toolPermissions } from "#src/vendor/agents.ts";

import { makeTree } from "./fixture.ts";

describe("plugin agents", () => {
  it("loads Claude agents with prompt paths, tool restrictions and metadata", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "review" }),
      "agents/audit.md": [
        "---",
        "name: audit",
        "description: Audit changes.",
        "tools: Read, Grep, Bash(git:*), Agent(review:helper)",
        "model: inherit",
        "color: green",
        "maxTurns: 6",
        "---",
        // oxlint-disable-next-line no-template-curly-in-string -- literal plugin placeholder
        "Read ${CLAUDE_PLUGIN_ROOT}/policy.md.",
      ].join("\n"),
    });
    const result = await loadAll([root], { dataRoot: path.join(root, "data") });
    expect(result.diagnostics).toEqual([]);
    const [plugin] = result.plugins;
    expect(plugin?.agents[0]).toEqual({
      color: "#22c55e",
      description: "Audit changes.",
      mode: "subagent",
      name: "audit",
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "grep", effect: "allow", resource: "*" },
        { action: "read", effect: "allow", resource: "*" },
        { action: "shell", effect: "allow", resource: "git *" },
        { action: "subagent", effect: "allow", resource: "review:helper" },
      ],
      steps: 6,
      system: `Read ${root}/policy.md.`,
    });
    if (plugin === undefined) {
      throw new Error("plugin missing");
    }
    const [agent] = toAgentInfo(plugin);
    expect([agent?.id, agent?.mode, agent?.system]).toEqual([
      "review:audit",
      "subagent",
      `Read ${root}/policy.md.`,
    ]);
    const scoped = scopeComponents(plugin, new Set(["skills"]));
    expect(toAgentInfo(scoped)).toEqual([]);
  });

  it("loads Cursor agents from declared paths instead of the default directory", async () => {
    const root = await makeTree({
      ".cursor-plugin/plugin.json": JSON.stringify({ agents: "./custom", name: "cursor" }),
      "agents/ignored.md": "Ignored.",
      "custom/reviewer.md": "---\nname: reviewer\ndescription: Reviews.\n---\nReview only.",
    });
    const result = await loadAll([root], { dataRoot: path.join(root, "data") });
    expect(result.plugins[0]?.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
  });

  it("does not widen restrictions or grant unknown tools", () => {
    const warnings: string[] = [];
    const rules = toolPermissions(["Read(secret.txt)", "Mystery", "Agent(x,y)"], (message) => {
      warnings.push(message);
    });
    expect(rules).toEqual([
      { action: "*", effect: "deny", resource: "*" },
      { action: "subagent", effect: "allow", resource: "x" },
      { action: "subagent", effect: "allow", resource: "y" },
    ]);
    expect(warnings).toEqual([
      "tools with no OpenCode equivalent were not granted: Read(secret.txt), Mystery",
    ]);
  });
});
