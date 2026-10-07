import { homedir } from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";
import type { Plugin as PluginTypes } from "@opencode/plugin";

import { loadAll } from "#src/loader.ts";
import { scopeComponents, toAgentInfo, toPolicyServerConfigs, toSkillInfo } from "#src/opencode.ts";
import { parseOptions } from "#src/options.ts";
import type { Options } from "#src/options.ts";
import { registerCompatibility } from "#src/runtime/compatibility.ts";
import { registerMcpPolicies } from "#src/runtime/mcp-policy.ts";
import { registerCommands } from "#src/runtime/plugin-commands.ts";
import { resourceScope } from "#src/runtime/resources.ts";
import type { Diagnostic, LoadResult } from "#src/types.ts";

type Context = PluginTypes.Context;

// Transforms replay on reload, so they read the latest load through this holder.
interface State {
  current: LoadResult;
}

const logDiagnostics = (diagnostics: readonly Diagnostic[]) => {
  for (const diagnostic of diagnostics) {
    console.warn(
      `[agent-plugins] ${diagnostic.severity}: ${diagnostic.source}: ${diagnostic.message}`,
    );
  }
};

const report = (diagnostic: Diagnostic) => {
  logDiagnostics([diagnostic]);
};

const readOptions = (ctx: Context) => {
  const home = homedir();
  const diagnostics: Diagnostic[] = [];
  const options = parseOptions(
    {
      dataHome: process.env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"),
      home,
      project: ctx.location.project.directory,
      raw: ctx.options,
    },
    (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  );
  return { diagnostics, options };
};

const registerSkillsAndMcp = async (ctx: Context, options: Options, state: State) => {
  const { components } = options;
  if (components.has("skills") || components.has("rules")) {
    await ctx.skill.transform((editor) => {
      for (const skill of state.current.plugins.flatMap(toSkillInfo)) {
        editor.add(skill);
      }
    });
  }
  if (components.has("mcp")) {
    await ctx.mcp.transform((editor) => {
      for (const [name, config] of state.current.plugins.flatMap(toPolicyServerConfigs)) {
        editor.set(name, config);
      }
    });
  }
};

const loadConfiguredPlugins = async (
  options: Options,
  optionDiagnostics: readonly Diagnostic[],
): Promise<LoadResult> => {
  const result = await loadAll(options.searchPaths, {
    appEndpoints: options.appEndpoints,
    configuration: options.configuration,
    dataRoot: options.dataRoot,
    env: process.env,
    formats: options.formats,
    pluginAppEndpoints: options.pluginAppEndpoints,
    pluginSettings: options.pluginSettings,
    trustedHooks: options.trustedHooks,
    ...(options.codexCache === undefined ? {} : { codexCache: options.codexCache }),
  });
  const loaded = {
    diagnostics: [...optionDiagnostics, ...result.diagnostics],
    plugins: result.plugins.map((plugin) => scopeComponents(plugin, options.components)),
  };
  logDiagnostics(loaded.diagnostics);
  return loaded;
};

export default Plugin.define({
  id: "agent-plugins",
  async setup(ctx) {
    const { diagnostics: optionDiagnostics, options } = readOptions(ctx);
    const load = async () => loadConfiguredPlugins(options, optionDiagnostics);
    const state: State = { current: await load() };

    const resources = resourceScope();
    try {
      resources.own(await registerMcpPolicies(ctx, () => state.current.plugins));
      const compatibility = resources.own(
        await registerCompatibility(ctx, options, () => state.current, report),
      );
      const reload = async () => {
        state.current = await load();
        await compatibility.replace();
        await Promise.all([
          ctx.skill.reload(),
          ctx.mcp.reload(),
          ctx.command.reload(),
          ctx.agent.reload(),
          ctx.tool.reload(),
        ]);
      };
      await registerSkillsAndMcp(ctx, options, state);
      if (options.components.has("agents")) {
        await ctx.agent.transform((editor) => {
          for (const agent of state.current.plugins.flatMap(toAgentInfo)) {
            editor.update(agent.id, (draft) => {
              Object.assign(draft, agent);
            });
          }
        });
      }
      await registerCommands(ctx, options, state, reload, compatibility);
      return async () => {
        await resources.dispose();
      };
    } catch (error) {
      await resources.dispose();
      throw error;
    }
  },
});
