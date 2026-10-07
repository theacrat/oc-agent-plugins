import { homedir } from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";

import { isStringArray } from "@/json.ts";
import { loadAll } from "@/loader.ts";
import { formatStatus, toServerConfigs, toSkillInfo } from "@/opencode.ts";
import type { LoadResult } from "@/types.ts";

const dataHome = () => process.env["XDG_DATA_HOME"] ?? path.join(homedir(), ".local", "share");

const expandHome = (value: string) => value.replace(/^~(?=\/|$)/u, homedir());

const logDiagnostics = (result: LoadResult) => {
  for (const diagnostic of result.diagnostics) {
    console.warn(
      `[agent-plugins] ${diagnostic.severity}: ${diagnostic.source}: ${diagnostic.message}`,
    );
  }
};

export default Plugin.define({
  id: "agent-plugins",
  async setup(ctx) {
    const project = ctx.location.project.directory;
    const { dataDir, paths } = ctx.options;
    const searchPaths = [
      path.join(homedir(), ".agents", "plugins"),
      path.join(project, ".agents", "plugins"),
      ...(isStringArray(paths)
        ? paths.map((entry) => path.resolve(project, expandHome(entry)))
        : []),
    ];
    const dataRoot =
      typeof dataDir === "string"
        ? path.resolve(project, expandHome(dataDir))
        : path.join(dataHome(), "opencode", "agent-plugins");

    let state = await loadAll(searchPaths, { dataRoot });
    logDiagnostics(state);

    await ctx.skill.transform((editor) => {
      for (const skill of state.plugins.flatMap(toSkillInfo)) {
        editor.add(skill);
      }
    });
    await ctx.mcp.transform((editor) => {
      for (const [name, config] of state.plugins.flatMap(toServerConfigs)) {
        editor.set(name, config);
      }
    });
    await ctx.command.transform((editor) => {
      editor.add({
        description: "Rescan Agent Plugins and show what loaded",
        async execute({ sessionID }) {
          state = await loadAll(searchPaths, { dataRoot });
          logDiagnostics(state);
          await Promise.all([ctx.skill.reload(), ctx.mcp.reload()]);
          await ctx.session.synthetic({
            resume: false,
            sessionID,
            text: formatStatus(state, searchPaths),
          });
        },
        name: "agent-plugins",
      });
    });
  },
});
