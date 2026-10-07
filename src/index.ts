import { homedir } from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";
import type { Plugin as PluginTypes } from "@opencode/plugin";

import { forwardAttachments } from "#src/attachments.ts";
import { loadAll } from "#src/loader.ts";
import {
  alwaysRules,
  formatStatus,
  scopeComponents,
  toAgentInfo,
  toCommands,
  toServerConfigs,
  toSkillInfo,
} from "#src/opencode.ts";
import { parseOptions } from "#src/options.ts";
import type { Options } from "#src/options.ts";
import { addLspExportCommand } from "#src/runtime/lsp.ts";
import { describeInjections, injectShell, shellRunner } from "#src/shell.ts";
import { renderCommand } from "#src/template.ts";
import type { Rendered } from "#src/template.ts";
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
      for (const [name, config] of state.current.plugins.flatMap(toServerConfigs)) {
        editor.set(name, config);
      }
    });
  }
  if (components.has("rules")) {
    // Always-on rules apply to every agent-loop request, like Cursor's alwaysApply.
    await ctx.session.hook("context", (event) => {
      for (const text of state.current.plugins.flatMap(alwaysRules)) {
        event.system.push({ text, type: "text" });
      }
    });
  }
};

const runShell = shellRunner(process.env["SHELL"] ?? "/bin/sh");

const registerCommands = async (
  ctx: Context,
  options: Options,
  state: State,
  reload: () => Promise<void>,
) => {
  // Only Claude-format templates contain `!`cmd`` injections; others render with an empty list.
  const expandShell = async (rendered: Rendered, sessionID: string) => {
    if (rendered.shell.length === 0 || !options.shellInjection) {
      return describeInjections(rendered);
    }
    const session = await ctx.session.get({ sessionID });
    return injectShell(rendered, session.location.directory, AbortSignal.timeout(60_000), runShell);
  };
  await ctx.command.transform((editor) => {
    addLspExportCommand(ctx, editor, () => state.current);
    editor.add({
      description: "Rescan Agent Plugins and show what loaded",
      async execute({ sessionID }) {
        await reload();
        await ctx.session.synthetic({
          resume: false,
          sessionID,
          text: formatStatus(state.current, options.searchPaths),
        });
      },
      name: "agent-plugins",
    });
    for (const { command, name } of state.current.plugins.flatMap(toCommands)) {
      editor.add({
        ...(command.description === undefined ? {} : { description: command.description }),
        async execute({ delivery, prompt, sessionID }) {
          const text = await expandShell(renderCommand(command, prompt.text), sessionID);
          await ctx.session.prompt({ delivery, sessionID, text, ...forwardAttachments(prompt) });
        },
        name,
      });
    }
  });
};

export default Plugin.define({
  id: "agent-plugins",
  async setup(ctx) {
    const { diagnostics: optionDiagnostics, options } = readOptions(ctx);
    const load = async (): Promise<LoadResult> => {
      const result = await loadAll(options.searchPaths, {
        appEndpoints: options.appEndpoints,
        dataRoot: options.dataRoot,
        env: process.env,
        formats: options.formats,
        ...(options.codexCache === undefined ? {} : { codexCache: options.codexCache }),
      });
      const loaded = {
        diagnostics: [...optionDiagnostics, ...result.diagnostics],
        plugins: result.plugins.map((plugin) => scopeComponents(plugin, options.components)),
      };
      logDiagnostics(loaded.diagnostics);
      return loaded;
    };
    const state: State = { current: await load() };
    const reload = async () => {
      state.current = await load();
      await Promise.all([
        ctx.skill.reload(),
        ctx.mcp.reload(),
        ctx.command.reload(),
        ctx.agent.reload(),
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
    await registerCommands(ctx, options, state, reload);
  },
});
