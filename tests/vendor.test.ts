import { chmod, realpath } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { parseOptions } from "#src/options.ts";
import type { Diagnostic, Format } from "#src/types.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";

import { makeTree, manifest, skill } from "./fixture.ts";

const json = (value: unknown) => JSON.stringify(value);
// oxlint-disable-next-line no-template-curly-in-string -- literal vendor placeholder
const CLAUDE_ROOT = "${CLAUDE_PLUGIN_ROOT}";
// oxlint-disable-next-line no-template-curly-in-string -- literal vendor placeholder
const CLAUDE_DATA = "${CLAUDE_PLUGIN_DATA}";
// oxlint-disable-next-line no-template-curly-in-string -- literal vendor placeholder
const CURSOR_ROOT = "${CURSOR_PLUGIN_ROOT}";
// oxlint-disable-next-line no-template-curly-in-string -- literal env placeholder
const TOKEN = "${TOKEN}";
// oxlint-disable-next-line no-template-curly-in-string -- literal vendor placeholder
const SKILL_DIR = "${CLAUDE_SKILL_DIR}";
// oxlint-disable-next-line no-template-curly-in-string -- literal env placeholder with default
const WITH_DEFAULT = "${MISSING:-fallback}";

const load = async (dir: string, formats?: readonly Format[], env: Record<string, string> = {}) => {
  const result = await loadAll([dir], {
    dataRoot: path.join(dir, "..", `${path.basename(dir)}-data`),
    env,
    ...(formats === undefined ? {} : { formats: new Set(formats) }),
  });
  return { ...result, root: await realpath(dir) };
};

const sources = (diagnostics: readonly Diagnostic[]) => diagnostics.map((entry) => entry.source);

describe("claude", () => {
  it("loads skills, commands and merges .mcp.json with inline servers", async () => {
    const dir = await makeTree({
      ".claude-plugin/plugin.json": json({
        mcpServers: { inline: { args: [`${CLAUDE_ROOT}/x.js`], command: "node" } },
        name: "deploy-tools",
        skills: ["./extra/"],
        version: "1.2.0",
      }),
      ".mcp.json": json({
        api: {
          headers: { Authorization: `Bearer ${TOKEN}` },
          type: "http",
          url: "https://api.example.com/mcp",
        },
        inline: { command: "replaced-by-manifest" },
      }),
      "commands/release/notes.md":
        "---\ndescription: Notes\nargument-hint: [tag] [--draft]\n---\n\nWrite notes for $ARGUMENTS.",
      "commands/status.md": "Show status.",
      "extra/lint/SKILL.md": skill("lint"),
      "skills/deploy/SKILL.md": `---\ndescription: Deploys.\ndisable-model-invocation: yes\n---\nRun ${CLAUDE_ROOT}/bin/deploy from ${SKILL_DIR}; keep ${TOKEN}.`,
    });
    const { diagnostics, plugins, root } = await load(dir, undefined, { TOKEN: "secret" });
    const [plugin] = plugins;
    expect(diagnostics).toEqual([]);
    expect(plugin?.format).toBe("claude");
    expect(plugin?.manifest).toEqual({ name: "deploy-tools", version: "1.2.0" });
    expect(
      plugin?.skills.map((entry) => [entry.name, entry.description, entry.autoinvoke ?? true]),
    ).toEqual([
      ["deploy", "Deploys.", false],
      ["lint", "Does lint things.", true],
    ]);
    expect(plugin?.skills[0]?.content).toBe(
      `Run ${root}/bin/deploy from ${root}/skills/deploy; keep ${TOKEN}.`,
    );
    expect(plugin?.commands).toEqual([
      {
        arguments: [],
        description: "Notes",
        name: "release:notes",
        syntax: "claude",
        template: "Write notes for $ARGUMENTS.",
      },
      { arguments: [], name: "status", syntax: "claude", template: "Show status." },
    ]);
    expect(plugin?.servers["api"]).toEqual({
      headers: { Authorization: "Bearer secret" },
      type: "streamable-http",
      url: "https://api.example.com/mcp",
    });
    expect(plugin?.servers["inline"]).toEqual({
      args: [`${root}/x.js`],
      command: "node",
      cwd: root,
      env: { CLAUDE_PLUGIN_DATA: plugin?.dataDir, CLAUDE_PLUGIN_ROOT: root },
      type: "stdio",
    });
  });

  it("uses defaults for missing env vars and leaves unknown ones literal", () => {
    const { expand } = placeholdersFor("claude", { dataDir: "/d", env: {}, root: "/r" });
    expect(expand(`${CLAUDE_ROOT}|${CLAUDE_DATA}|${WITH_DEFAULT}|${TOKEN}`)).toBe(
      `/r|/d|fallback|${TOKEN}`,
    );
  });

  it("loads a manifest-less plugin listed by a marketplace", async () => {
    const outside = await makeTree({ ".claude-plugin/plugin.json": json({ name: "evil" }) });
    const dir = await makeTree({
      ".claude-plugin/marketplace.json": json({
        name: "market",
        plugins: [
          { name: "lsp", source: "./plugins/lsp" },
          { name: "remote", source: { source: "url", url: "https://github.com/x/y.git" } },
          { name: "escape", source: "./link" },
          { name: "gone", source: "./missing" },
        ],
      }),
      link: { symlink: outside },
      "plugins/lsp/skills/hover/SKILL.md": skill("hover"),
    });
    const { diagnostics, plugins } = await load(dir);
    expect(plugins.map((entry) => [entry.manifest.name, entry.format])).toEqual([
      ["lsp", "claude"],
    ]);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      'plugin source "./link" escapes the marketplace; skipped',
      'plugin source "./missing" is not a directory; skipped',
      "1 plugin(s) with git, url or npm sources aren't installed here; install them with their host first",
    ]);
  });

  it("doesn't reload a rejected marketplace entry as a child directory", async () => {
    const outside = await makeTree({
      ".claude-plugin/plugin.json": json({ name: "evil" }),
      "commands/s.md": "Evil.",
    });
    const dir = await makeTree({
      ".claude-plugin/marketplace.json": json({
        name: "m",
        plugins: [{ name: "evil", source: "./link" }],
      }),
      link: { symlink: outside },
    });
    const { diagnostics, plugins } = await load(dir);
    expect(plugins).toEqual([]);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      'plugin source "./link" escapes the marketplace; skipped',
    ]);
  });

  it("reports components OpenCode can't use", async () => {
    const dir = await makeTree({
      ".claude-plugin/plugin.json": json({ lspServers: "./.lsp.json", name: "x" }),
      "agents/reviewer.md": "Review.",
      "hooks/hooks.json": "{}",
    });
    const { diagnostics } = await load(dir);
    expect(diagnostics).toEqual([
      {
        message: "LSP config is missing or outside the plugin root",
        severity: "error",
        source: "x/.lsp.json",
      },
      {
        message: "hooks configuration must contain a hooks object",
        severity: "error",
        source: "x/hooks/hooks.json",
      },
    ]);
  });

  it("rejects component paths that escape the root", async () => {
    const dir = await makeTree({
      ".claude-plugin/plugin.json": json({ commands: ["../evil"], name: "x", skills: "/etc" }),
    });
    const { diagnostics } = await load(dir);
    expect(diagnostics.map((entry) => entry.message).toSorted()).toEqual([
      'commands path "../evil" escapes the plugin root',
      'skills path "/etc" must be relative to the plugin root',
    ]);
  });
});

describe("codex", () => {
  it("expands PLUGIN_ROOT, leaves env vars literal and ignores host fields", async () => {
    const dir = await makeTree({
      ".codex-plugin/plugin.json": json({
        apps: "./.app.json",
        mcpServers: "./.mcp.json",
        name: "cx",
        skills: "./skills/",
      }),
      ".mcp.json": json({
        mcpServers: {
          local: {
            args: [`${CLAUDE_ROOT}/a`, TOKEN],
            command: "node",
            cwd: ".",
            enabled: true,
            env_vars: ["PATH"],
          },
        },
      }),
      "skills/one/SKILL.md": skill("one"),
    });
    const { diagnostics, plugins } = await load(dir, undefined, { TOKEN: "secret" });
    const server = plugins[0]?.servers["local"];
    expect(server).toBeUndefined();
    expect(plugins[0]?.skills.map((entry) => entry.name)).toEqual(["one"]);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "app manifest is missing or escapes the plugin root",
      "env_vars is not representable: native local MCP inherits the host environment and cannot enforce a vendor whitelist; use an explicitly environment-isolated stdio launcher",
    ]);
  });

  it("requires a manifest even when a marketplace lists the plugin", async () => {
    const dir = await makeTree({
      ".agents/plugins/marketplace.json": json({
        name: "m",
        plugins: [{ name: "bare", source: { path: "./plugins/bare", source: "local" } }],
      }),
      "plugins/bare/skills/one/SKILL.md": skill("one"),
    });
    const { diagnostics, plugins } = await load(dir);
    expect(plugins).toEqual([]);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "codex plugin rejected: .codex-plugin/plugin.json not found",
    ]);
  });
});

describe("cursor", () => {
  it("loads rules, a declared mcpServers that replaces mcp.json, and CURSOR_PLUGIN_ROOT", async () => {
    const dir = await makeTree({
      ".cursor-plugin/plugin.json": json({
        mcpServers: "./servers.json",
        name: "cur",
        variables: { properties: {}, type: "object" },
      }),
      "mcp.json": json({ mcpServers: { ignored: { command: "x" } } }),
      "rules/always.mdc": "---\nalwaysApply: true\n---\nAlways.",
      "rules/ts.mdc": '---\ndescription: TS\nglobs: "**/*.ts, **/*.tsx"\n---\nTS rule.',
      "servers.json": json({
        mcpServers: { db: { args: [`${CURSOR_ROOT}/db`], command: "node" } },
      }),
    });
    const { diagnostics, plugins, root } = await load(dir);
    const [plugin] = plugins;
    expect(Object.keys(plugin?.servers ?? {})).toEqual(["db"]);
    const db = plugin?.servers["db"];
    expect(db?.type === "stdio" && db.args).toEqual([`${root}/db`]);
    expect(plugin?.rules.map((rule) => [rule.name, rule.alwaysApply, rule.globs])).toEqual([
      ["always", true, []],
      ["ts", false, ["**/*.ts", "**/*.tsx"]],
    ]);
    expect(sources(diagnostics)).toEqual([]);
  });

  it("uses a root SKILL.md as a single-skill plugin", async () => {
    const dir = await makeTree({
      ".cursor-plugin/plugin.json": json({ name: "solo" }),
      "SKILL.md": "---\ndescription: Solo skill.\n---\nBody.",
    });
    const { plugins } = await load(dir);
    expect(plugins[0]?.skills.map((entry) => entry.description)).toEqual(["Solo skill."]);
  });
});

describe("unreadable files", () => {
  it.skipIf(process.getuid?.() === 0)(
    "skip only the affected component and keep sibling plugins",
    async () => {
      const dir = await makeTree({
        "a/.claude-plugin/plugin.json": json({ name: "a" }),
        "a/commands/locked.md": "Locked.",
        "a/commands/open.md": "Open.",
        "a/skills/locked/SKILL.md": skill("locked"),
        "b/.cursor-plugin/plugin.json": json({ name: "b" }),
        "b/rules/r.mdc": "Rule.",
      });
      await Promise.all([
        chmod(path.join(dir, "a/commands/locked.md"), 0o000),
        chmod(path.join(dir, "a/skills/locked/SKILL.md"), 0o000),
      ]);
      const { diagnostics, plugins } = await load(dir);
      expect(plugins.map((plugin) => plugin.manifest.name)).toEqual(["a", "b"]);
      expect(plugins[0]?.commands.map((command) => command.name)).toEqual(["open"]);
      expect(plugins[0]?.skills).toEqual([]);
      expect(diagnostics.map((entry) => entry.message.split(":")[0])).toEqual([
        "can't read file",
        "can't read file",
      ]);
    },
  );
});

describe("symlinked plugin roots", () => {
  it("loads a plugin whose root directory is a symlink", async () => {
    const real = await makeTree({
      ".claude-plugin/plugin.json": json({ name: "linked" }),
      "skills/one/SKILL.md": skill("one"),
    });
    const dir = await makeTree({ "plugins/linked": { symlink: real } });
    const { diagnostics, plugins } = await load(path.join(dir, "plugins"));
    expect(diagnostics).toEqual([]);
    expect(plugins.map((entry) => [entry.manifest.name, entry.skills.length])).toEqual([
      ["linked", 1],
    ]);
  });
});

describe("format precedence and toggles", () => {
  const multi = {
    ".claude-plugin/plugin.json": json({ name: "multi" }),
    ".codex-plugin/plugin.json": json({ name: "multi" }),
    ".cursor-plugin/plugin.json": json({ name: "multi" }),
    "plugin.json": manifest({ name: "multi" }),
  };

  it.each<[readonly Format[], Format | undefined]>([
    [["agent-plugins", "claude", "codex", "cursor"], "agent-plugins"],
    [["claude", "codex", "cursor"], "claude"],
    [["codex", "cursor"], "codex"],
    [["cursor"], "cursor"],
    [[], undefined],
  ])("formats %j load as %j", async (formats, expected) => {
    const dir = await makeTree(multi);
    const { plugins } = await load(dir, formats);
    expect(plugins[0]?.format).toBe(expected);
  });

  it("parses toggles and reports unknown options", () => {
    const diagnostics: Diagnostic[] = [];
    const options = parseOptions(
      {
        dataHome: "/data",
        home: "/home/u",
        project: "/p",
        raw: {
          components: { commands: { enabled: false } },
          discovery: { paths: ["~/plugins", "rel"] },
          formats: { claude: false, nope: true },
          wat: 1,
        },
      },
      (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    );
    expect([...options.formats]).toEqual(["agent-plugins", "codex", "cursor"]);
    expect([...options.components]).toEqual([
      "skills",
      "mcp",
      "rules",
      "agents",
      "hooks",
      "styles",
      "monitors",
      "lsp",
    ]);
    expect(options.searchPaths).toEqual([
      "/home/u/.agents/plugins",
      "/home/u/.config/opencode/agent-plugins",
      "/p/.agents/plugins",
      "/p/.opencode/agent-plugins",
      "/home/u/plugins",
      "/p/rel",
    ]);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      'unknown option "options.wat"',
      'unknown option "formats.nope"',
    ]);
  });
});
