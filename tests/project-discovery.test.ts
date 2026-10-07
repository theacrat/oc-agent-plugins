import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { parseOptions } from "#src/options.ts";

import { makeTree, manifest, skill } from "./fixture.ts";

describe("OpenCode-local vendor package discovery", () => {
  it("loads global OpenCode vendor packages across projects and honours the configured XDG directory", async () => {
    const root = await makeTree({
      "config/opencode/agent-plugins/shared/plugin.json": manifest({ name: "shared" }),
      "config/opencode/agent-plugins/shared/skills/review/SKILL.md": skill("review"),
      "config/opencode/plugins/native.ts": "throw new Error('must not load native code')",
    });
    await Promise.all(
      ["first", "second"].map(async (project) => {
        const options = parseOptions(
          {
            configHome: path.join(root, "config"),
            dataHome: path.join(root, "data"),
            home: path.join(root, "home"),
            project: path.join(root, project),
            raw: {},
          },
          (entry) => {
            throw new Error(entry.message);
          },
        );
        const result = await loadAll(options.searchPaths, { dataRoot: options.dataRoot });
        expect(result.diagnostics).toEqual([]);
        expect(result.plugins.map((plugin) => plugin.manifest.name)).toEqual(["shared"]);
      }),
    );
  });
  it("loads project-local packages without configuring extra paths or a global installation", async () => {
    const project = await makeTree({
      ".opencode/agent-plugins/claude/.claude-plugin/plugin.json": JSON.stringify({
        name: "local-claude",
      }),
      ".opencode/agent-plugins/claude/commands/check.md": "Check changes.",
      ".opencode/agent-plugins/demo/plugin.json": manifest(),
      ".opencode/agent-plugins/demo/skills/review/SKILL.md": skill("review"),
      ".opencode/plugins/native.ts": "throw new Error('must not import native plugins')",
    });
    const options = parseOptions(
      { dataHome: path.join(project, "data"), home: path.join(project, "home"), project, raw: {} },
      (entry) => {
        throw new Error(entry.message);
      },
    );
    const result = await loadAll(options.searchPaths, { dataRoot: options.dataRoot });
    expect(result.diagnostics).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.manifest.name)).toEqual(["local-claude", "demo"]);
    expect(result.plugins[1]?.skills.map((entry) => entry.name)).toEqual(["review"]);
    expect(result.plugins[0]?.commands[0]?.name).toBe("check");
  });

  it("does not search another project's local packages", async () => {
    const first = await makeTree({ ".opencode/agent-plugins/demo/plugin.json": manifest() });
    const second = await makeTree({ "README.md": "Another project." });
    const options = parseOptions(
      {
        dataHome: path.join(second, "data"),
        home: path.join(second, "home"),
        project: second,
        raw: {},
      },
      (entry) => {
        throw new Error(entry.message);
      },
    );
    const result = await loadAll(options.searchPaths, { dataRoot: options.dataRoot });
    expect(result.plugins).toEqual([]);
    expect(options.searchPaths).not.toContain(path.join(first, ".opencode", "agent-plugins"));
  });
});
