import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll, loadPlugin } from "@/loader.ts";

import { DATA, HOME_PLACEHOLDER, ROOT, makeTree, manifest, mcp, skill } from "./fixture.ts";

const byText = (left = "", right = "") => left.localeCompare(right);

const load = async (dir: string, platform: NodeJS.Platform = "linux") => {
  const dataRoot = path.join(dir, "..", `${dir.split("/").at(-1)}-data`);
  return { ...(await loadPlugin(dir, { dataRoot, platform })), dataRoot };
};

describe("skills", () => {
  it("discovers immediate children only and skips invalid skills", async () => {
    const dir = await makeTree({
      "plugin.json": manifest(),
      "skills/deploy/SKILL.md": skill("deploy"),
      "skills/deploy/nested/SKILL.md": skill("nested"),
      "skills/mismatch/SKILL.md": skill("other"),
      "skills/no-frontmatter/SKILL.md": "# hi",
      "skills/no-skill/README.md": "x",
    });
    const { plugin, diagnostics } = await load(dir);
    expect(plugin?.skills.map((entry) => [entry.name, entry.content])).toEqual([
      ["deploy", "# deploy\n\nBody of deploy."],
    ]);
    expect(diagnostics.map((entry) => entry.source)).toEqual([
      "demo/skills/mismatch",
      "demo/skills/no-frontmatter",
    ]);
  });

  it("skips a SKILL.md symlinked outside the root", async () => {
    const outside = await makeTree({ "SKILL.md": skill("escape") });
    const dir = await makeTree({
      "plugin.json": manifest(),
      "skills/escape/SKILL.md": { symlink: path.join(outside, "SKILL.md") },
    });
    const { plugin, diagnostics } = await load(dir);
    expect(plugin?.skills).toEqual([]);
    expect(diagnostics[0]?.message).toContain("inside the plugin root");
  });

  it("treats a skills file as an invalid component type without rejecting the plugin", async () => {
    const dir = await makeTree({ "plugin.json": manifest(), skills: "oops" });
    const { plugin, diagnostics } = await load(dir);
    expect(plugin?.manifest.name).toBe("demo");
    expect(diagnostics).toHaveLength(1);
  });
});

describe("mcp", () => {
  it("maps stdio and streamable-http, expanding placeholders once", async () => {
    const dir = await makeTree({
      "bin/server": "#!/bin/sh\n",
      "mcp.json": mcp({
        local: {
          args: ["--root", `${ROOT}/cfg`, HOME_PLACEHOLDER, DATA],
          command: "./bin/server",
          env: { CONFIG: `${DATA}/x` },
          type: "stdio",
        },
        remote: {
          headers: { "X-Tenant": "t" },
          type: "streamable-http",
          url: "https://example.com/mcp",
        },
      }),
      "plugin.json": manifest(),
    });
    const { plugin, diagnostics, dataRoot } = await load(dir);
    const root = await realpath(dir);
    const data = path.join(dataRoot, "demo");
    expect(diagnostics).toEqual([]);
    expect(plugin?.servers).toEqual({
      local: {
        args: ["--root", `${root}/cfg`, HOME_PLACEHOLDER, data],
        command: `${root}/bin/server`,
        cwd: root,
        env: { CONFIG: `${data}/x`, PLUGIN_DATA: data, PLUGIN_ROOT: root },
        type: "stdio",
      },
      remote: {
        headers: { "X-Tenant": "t" },
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    });
    const info = await stat(data);
    expect(info.isDirectory()).toBe(true);
  });

  it("does not rescan text introduced by expansion", async () => {
    const dir = await makeTree({
      "mcp.json": mcp({ s: { args: [DATA], command: "node", type: "stdio" } }),
      "plugin.json": manifest(),
    });
    const { plugin } = await loadPlugin(dir, {
      dataRoot: `/tmp/opencode/${ROOT}`,
      platform: "linux",
    });
    const server = plugin?.servers["s"];
    expect(server?.type === "stdio" && server.args).toEqual([`/tmp/opencode/${ROOT}/demo`]);
  });

  it("skips invalid entries but keeps valid siblings", async () => {
    const dir = await makeTree({
      "mcp.json": mcp({
        badCwd: { command: "node", cwd: "data", type: "stdio" },
        dataEscape: { command: "node", cwd: `${DATA}/../..`, type: "stdio" },
        dupHeader: {
          headers: { "X-A": "2", "x-a": "1" },
          type: "streamable-http",
          url: "https://example.com",
        },
        escapingCmd: { command: "../bin/x", type: "stdio" },
        escapingCwd: { command: "node", cwd: "./../..", type: "stdio" },
        good: { command: "node", type: "stdio" },
        httpRemote: { type: "streamable-http", url: "http://example.com/mcp" },
        loopback: { type: "streamable-http", url: "http://127.0.0.1:8080/mcp" },
        mixed: { command: "node", type: "stdio", url: "https://x" },
        reserved: { command: "node", env: { PLUGIN_ROOT: "/x" }, type: "stdio" },
        shellCmd: { command: "bin/x", type: "stdio" },
        sse: { type: "sse", url: "https://example.com/sse" },
        unknown: { type: "websocket", url: "wss://x" },
        userinfo: { type: "streamable-http", url: "https://u:p@example.com/" },
      }),
      "plugin.json": manifest(),
    });
    const { plugin, diagnostics } = await load(dir);
    expect(Object.keys(plugin?.servers ?? {}).toSorted(byText)).toEqual(["good", "loopback"]);
    expect(diagnostics.map((entry) => entry.source.split("#")[1]).toSorted(byText)).toEqual([
      "badCwd",
      "dataEscape",
      "dupHeader",
      "escapingCmd",
      "escapingCwd",
      "httpRemote",
      "mixed",
      "reserved",
      "shellCmd",
      "sse",
      "unknown",
      "userinfo",
    ]);
  });

  it("treats reserved env names case-insensitively on windows", async () => {
    const dir = await makeTree({
      "mcp.json": mcp({ s: { command: "node", env: { plugin_root: "x" }, type: "stdio" } }),
      "plugin.json": manifest(),
    });
    const windows = await load(dir, "win32");
    const linux = await load(dir, "linux");
    expect(Object.keys(windows.plugin?.servers ?? {})).toEqual([]);
    expect(Object.keys(linux.plugin?.servers ?? {})).toEqual(["s"]);
  });

  it("accepts a PLUGIN_DATA cwd and creates the data directory", async () => {
    const dir = await makeTree({
      "mcp.json": mcp({ s: { command: "node", cwd: DATA, type: "stdio" } }),
      "plugin.json": manifest(),
    });
    const { plugin, dataRoot } = await load(dir);
    const server = plugin?.servers["s"];
    expect(server?.type === "stdio" && server.cwd).toBe(
      await realpath(path.join(dataRoot, "demo")),
    );
  });

  it.each([
    [
      "wrong schema",
      mcp({}, { $schema: "https://agent-plugins.org/schemas/0.9.0/mcp.schema.json" }),
    ],
    ["extra top-level field", mcp({}, { servers: {} })],
    ["invalid JSON", "{"],
    [
      "missing mcpServers",
      JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" }),
    ],
  ])("disables MCP but keeps skills on %s", async (_label, content) => {
    const dir = await makeTree({
      "mcp.json": content,
      "plugin.json": manifest(),
      "skills/a/SKILL.md": skill("a"),
    });
    const { plugin, diagnostics } = await load(dir);
    expect(plugin?.servers).toEqual({});
    expect(plugin?.skills.map((entry) => entry.name)).toEqual(["a"]);
    expect(diagnostics[0]?.message).toContain("MCP disabled");
  });
});

describe("plugins", () => {
  it("rejects a plugin with a fatal manifest error without discovering components", async () => {
    const dir = await makeTree({
      "plugin.json": manifest({ name: "Bad" }),
      "skills/a/SKILL.md": skill("a"),
    });
    const { plugin, diagnostics } = await load(dir);
    expect(plugin).toBeUndefined();
    expect(diagnostics[0]?.message).toMatch(/^plugin rejected: name must be/u);
  });

  it("rejects a plugin.json symlinked outside the root", async () => {
    const outside = await makeTree({ "plugin.json": manifest() });
    const dir = await makeTree({ "plugin.json": { symlink: path.join(outside, "plugin.json") } });
    const { plugin } = await load(dir);
    expect(plugin).toBeUndefined();
  });

  it("loads a directory of plugins, ignores non-plugins and dedupes names", async () => {
    const dir = await makeTree({
      "a/plugin.json": manifest({ name: "alpha" }),
      "b/plugin.json": manifest({ name: "alpha" }),
      "c/README.md": "not a plugin",
      "d/plugin.json": manifest({ name: "delta" }),
    });
    const result = await loadAll([dir, path.join(dir, "d"), path.join(dir, "missing")], {
      dataRoot: path.join(dir, "data"),
    });
    expect(result.plugins.map((entry) => entry.manifest.name)).toEqual(["alpha", "delta"]);
    expect(result.diagnostics.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^skipped .*\/b; a plugin with this name was already loaded from/u),
    ]);
  });
});
