import type { Plugin } from "@opencode/plugin";
import type { CommandEditor } from "@opencode/plugin/promise/command";

import type { Options } from "#src/options.ts";
import {
  addMonitorCommand,
  addRuntimeExportCommand,
  addStyleCommand,
} from "#src/runtime/compatibility-commands.ts";
import { registerConfiguredHooks } from "#src/runtime/compatibility-hooks.ts";
import { setupCompatibilityLifecycle } from "#src/runtime/compatibility-lifecycle.ts";
import { registerMonitors } from "#src/runtime/monitors.ts";
import { resourceScope } from "#src/runtime/resources.ts";
import { registerScopedRules } from "#src/runtime/rules.ts";
import { registerOutputStyles } from "#src/runtime/styles.ts";
import type { LoadResult, Report } from "#src/types.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";

const deliverMonitor = async (
  ctx: Plugin.Context,
  sessionID: string,
  plugin: string,
  monitor: string,
  text: string,
  report: Report,
) => {
  try {
    await ctx.session.synthetic({
      resume: false,
      sessionID,
      text: `Monitor ${plugin}:${monitor}\n${text}`,
    });
  } catch {
    report({ message: "monitor output delivery failed", severity: "warning", source: monitor });
  }
};

const createMonitors = (
  ctx: Plugin.Context,
  options: Options,
  result: LoadResult,
  report: Report,
) =>
  result.plugins.map((plugin) =>
    registerMonitors(
      (plugin.runtimes?.monitors ?? []).map((monitor) => ({
        command:
          plugin.format === "agent-plugins"
            ? monitor.command
            : placeholdersFor(plugin.format, {
                dataDir: plugin.dataDir,
                env: {},
                root: plugin.root,
              }).expandContent(monitor.command),
        description: monitor.description,
        name: monitor.name,
        when: monitor.when,
      })),
      {
        cwd: ctx.location.directory,
        env: {
          CLAUDE_PLUGIN_DATA: plugin.dataDir,
          CLAUDE_PLUGIN_ROOT: plugin.root,
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        interactive: true,
        notify: (sessionID, monitor, text) => {
          void deliverMonitor(ctx, sessionID, plugin.manifest.name, monitor, text, report);
        },
        report,
        trusted: options.trustedMonitors.includes(plugin.manifest.name),
      },
    ),
  );

const replaceMonitors = async (
  previous: readonly ReturnType<typeof registerMonitors>[],
  create: () => ReturnType<typeof createMonitors>,
) => {
  await Promise.all(previous.map(async (monitor) => monitor.dispose()));
  return create();
};

const styleSources = (result: LoadResult, options: Options) =>
  result.plugins.map((plugin) => ({
    allowSystemReplacement:
      options.componentOverrides[plugin.manifest.name]?.allowSystemReplacement ??
      options.allowSystemReplacement,
    plugin: plugin.manifest.name,
    styles: plugin.styles ?? [],
  }));

const setupRulesAndStyles = async (
  ctx: Plugin.Context,
  options: Options,
  current: () => LoadResult,
  owned: ReturnType<typeof resourceScope>,
) => {
  const rules = owned.own(
    await registerScopedRules(
      ctx,
      ctx.location.directory,
      current().plugins.flatMap((plugin) => plugin.rules),
    ),
  );
  const sources = styleSources(current(), options);
  const output = owned.own(
    await registerOutputStyles(
      ctx,
      sources,
      {},
      { allowSystemReplacement: options.allowSystemReplacement },
    ),
  );
  return { output, rules };
};

const compatibilityControls = (
  ctx: Plugin.Context,
  options: Options,
  current: () => LoadResult,
  report: Report,
  owned: ReturnType<typeof resourceScope>,
  scopedSessions: Set<string>,
  rules: Awaited<ReturnType<typeof registerScopedRules>>,
  output: Awaited<ReturnType<typeof registerOutputStyles>>,
  monitors: { current: ReturnType<typeof createMonitors> },
) => ({
  addCommands: (editor: CommandEditor) => {
    addStyleCommand(ctx, editor, output, scopedSessions);
    addMonitorCommand(ctx, editor, () => monitors.current);
    addRuntimeExportCommand(ctx, editor, current);
  },
  async dispose() {
    scopedSessions.clear();
    await owned.dispose();
  },
  async replace() {
    rules.replace(current().plugins.flatMap((plugin) => plugin.rules));
    output.replace(styleSources(current(), options));
    monitors.current = await replaceMonitors(monitors.current, () =>
      createMonitors(ctx, options, current(), report),
    );
  },
});

const registerCompatibility = async (
  ctx: Plugin.Context,
  options: Options,
  current: () => LoadResult,
  report: Report,
) => {
  const owned = resourceScope();
  try {
    const { output, rules } = await setupRulesAndStyles(ctx, options, current, owned);
    const hooks = await registerConfiguredHooks(ctx, options, current, report);
    owned.own({ dispose: hooks });
    const monitors = { current: createMonitors(ctx, options, current(), report) };
    owned.own({
      dispose: async () => {
        await Promise.all(monitors.current.map(async (monitor) => monitor.dispose()));
      },
    });
    const scopedSessions = new Set<string>();
    const stopEvents = await setupCompatibilityLifecycle(
      ctx,
      options,
      scopedSessions,
      output,
      rules,
      current,
      () => monitors.current,
      report,
    );
    owned.own({ dispose: stopEvents });
    return compatibilityControls(
      ctx,
      options,
      current,
      report,
      owned,
      scopedSessions,
      rules,
      output,
      monitors,
    );
  } catch (error) {
    await owned.dispose();
    throw error;
  }
};

export { registerCompatibility };
