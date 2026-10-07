import { describe, expect, it } from "vitest";

import { formatStatus, toServerConfigs, toSkillInfo } from "@/opencode.ts";
import type { AgentPlugin } from "@/types.ts";

const plugin: AgentPlugin = {
  dataDir: "/data/demo",
  manifest: { name: "demo", version: "1.0.0" },
  root: "/plugins/demo",
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
  it("namespaces skills by plugin name", () => {
    expect(toSkillInfo(plugin)).toEqual([
      {
        content: "Body",
        description: "Does things.",
        id: "demo:deploy",
        name: "deploy",
        path: "/plugins/demo/skills/deploy/SKILL.md",
      },
    ]);
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
        "demo@1.0.0 (/plugins/demo)",
        "  skills: demo:deploy",
        "  mcp: demo-local, demo-remote",
        "",
        "Diagnostics:",
        "- error: demo/mcp.json#x: bad",
      ].join("\n"),
    );
  });
});
