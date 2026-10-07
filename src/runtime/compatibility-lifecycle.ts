import type { Plugin } from "@opencode/plugin";

import type { MonitorRuntime } from "#src/runtime/compatibility-commands.ts";
import type { RuleRuntime } from "#src/runtime/rules.ts";
import type { StyleRuntime } from "#src/runtime/styles.ts";
import type { LoadResult, Report } from "#src/types.ts";

const scopeOutputStyles = async (
  ctx: Plugin.Context,
  selectedStyle: string | undefined,
  scoped: Set<string>,
  output: StyleRuntime,
) =>
  ctx.session.hook("prompt", (event) => {
    if (scoped.has(event.sessionID)) {
      return;
    }
    scoped.add(event.sessionID);
    const selected = selectedStyle?.split(":");
    output.select(
      event.sessionID,
      selected?.[0] !== undefined && selected[1] !== undefined
        ? { name: selected.slice(1).join(":"), plugin: selected[0] }
        : undefined,
    );
  });

const watchCompatibilitySessions = (
  ctx: Plugin.Context,
  scoped: Set<string>,
  output: StyleRuntime,
  rules: RuleRuntime,
  current: () => LoadResult,
  monitors: () => readonly MonitorRuntime[],
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
          await Promise.all(monitors().map(async (monitor) => monitor.stopSession(sessionID)));
        } else if (event.type === "session.skill.activated" && scoped.has(event.data.sessionID)) {
          const index = current().plugins.findIndex((plugin) =>
            event.data.id.startsWith(`${plugin.manifest.name}:`),
          );
          const plugin = current().plugins[index];
          if (plugin !== undefined) {
            monitors()[index]?.invokeSkill(
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
  selectedStyle: string | undefined,
  scoped: Set<string>,
  output: StyleRuntime,
  rules: RuleRuntime,
  current: () => LoadResult,
  monitors: () => readonly MonitorRuntime[],
  report: Report,
) => {
  const stop = watchCompatibilitySessions(ctx, scoped, output, rules, current, monitors, report);
  try {
    const prompt = await scopeOutputStyles(ctx, selectedStyle, scoped, output);
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
