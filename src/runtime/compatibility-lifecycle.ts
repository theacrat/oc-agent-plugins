import type { Plugin } from "@opencode/plugin";

import type { Options } from "#src/options.ts";
import type { MonitorRuntime } from "#src/runtime/compatibility-commands.ts";
import { defaultStyle } from "#src/runtime/default-style.ts";
import type { RuleRuntime } from "#src/runtime/rules.ts";
import type { StyleRuntime } from "#src/runtime/styles.ts";
import type { LoadResult, Report } from "#src/types.ts";

const scopeOutputStyles = async (
  ctx: Plugin.Context,
  options: Options,
  scoped: Set<string>,
  output: StyleRuntime,
  current: () => LoadResult,
) =>
  ctx.session.hook("prompt", (event) => {
    if (scoped.has(event.sessionID)) {
      return;
    }
    output.select(event.sessionID, defaultStyle(options, current()));
    scoped.add(event.sessionID);
  });

const watchCompatibilitySessions = (
  ctx: Plugin.Context,
  scoped: Set<string>,
  output: StyleRuntime,
  rules: RuleRuntime,
  current: () => LoadResult,
  monitors: () => ReadonlyMap<string, MonitorRuntime>,
  report: Report,
) => {
  const controller = new AbortController();
  const listen = async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") {
          const { sessionID } = event.data;
          scoped.delete(sessionID);
          output.clearSession(sessionID);
          rules.clearSession(sessionID);
          await Promise.all(
            [...monitors().values()].map(async (monitor) => monitor.stopSession(sessionID)),
          );
        } else if (event.type === "session.skill.activated" && scoped.has(event.data.sessionID)) {
          const plugin = current().plugins.find((entry) =>
            event.data.id.startsWith(`${entry.manifest.name}:`),
          );
          if (plugin !== undefined) {
            monitors()
              .get(plugin.manifest.name)
              ?.invokeSkill(
                event.data.sessionID,
                event.data.id.slice(plugin.manifest.name.length + 1),
              );
          }
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        report({
          message: "compatibility lifecycle event stream ended",
          severity: "warning",
          source: "runtime",
        });
      }
    }
  };
  void listen();
  return () => {
    controller.abort();
  };
};

const setupCompatibilityLifecycle = async (
  ctx: Plugin.Context,
  options: Options,
  scoped: Set<string>,
  output: StyleRuntime,
  rules: RuleRuntime,
  current: () => LoadResult,
  monitors: () => ReadonlyMap<string, MonitorRuntime>,
  report: Report,
) => {
  const stop = watchCompatibilitySessions(ctx, scoped, output, rules, current, monitors, report);
  try {
    defaultStyle(options, current());
    const prompt = await scopeOutputStyles(ctx, options, scoped, output, current);
    return async () => {
      stop();
      await prompt.dispose();
    };
  } catch (error) {
    stop();
    throw error;
  }
};

export { setupCompatibilityLifecycle, watchCompatibilitySessions };
