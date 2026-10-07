import type { Plugin } from "@opencode/plugin";
import type { CommandEditor } from "@opencode/plugin/promise/command";

import type { registerMonitors } from "#src/runtime/monitors.ts";
import type { StyleRuntime } from "#src/runtime/styles.ts";
import { exportWorkflow } from "#src/runtime/workflows.ts";
import type { LoadResult } from "#src/types.ts";
import { exportTheme } from "#src/vendor/themes.ts";

type MonitorRuntime = ReturnType<typeof registerMonitors>;

const addStyleCommand = (
  ctx: Plugin.Context,
  editor: CommandEditor,
  output: StyleRuntime,
  scoped: Set<string>,
) => {
  editor.add({
    description: "Select plugin:name, or clear, for this session's output style",
    async execute({ sessionID, prompt }) {
      const value = prompt.text.trim();
      const [plugin, ...names] = value.split(":");
      output.select(
        sessionID,
        value === "clear" ? undefined : { name: names.join(":"), plugin: plugin ?? "" },
      );
      scoped.add(sessionID);
      await ctx.session.synthetic({
        resume: false,
        sessionID,
        text: `Output style ${value === "clear" ? "cleared" : "selected"}.`,
      });
    },
    name: "agent-plugins-style",
  });
};

const addMonitorCommand = (
  ctx: Plugin.Context,
  editor: CommandEditor,
  current: () => ReadonlyMap<string, MonitorRuntime>,
) => {
  editor.add({
    description: "Explicitly start or stop trusted monitors for this session",
    async execute({ sessionID, prompt }) {
      if (prompt.text.trim() === "start") {
        for (const monitor of current().values()) {
          monitor.startSession(sessionID);
        }
      } else if (prompt.text.trim() === "stop") {
        await Promise.all(
          [...current().values()].map(async (monitor) => monitor.stopSession(sessionID)),
        );
      } else {
        throw new Error("Use start or stop; monitors require trustedMonitors opt-in");
      }
      await ctx.session.synthetic({
        resume: false,
        sessionID,
        text: `Monitors ${prompt.text.trim()} requested.`,
      });
    },
    name: "agent-plugins-monitors",
  });
};

const addRuntimeExportCommand = (
  ctx: Plugin.Context,
  editor: CommandEditor,
  current: () => LoadResult,
) => {
  editor.add({
    description: "Export discovered workflows and themes with exact bridge requirements",
    async execute({ sessionID }) {
      const exports = current().plugins.map((plugin) => ({
        // Configuration schemas may contain sensitive defaults, so never expose them in model text.
        channels: (plugin.runtimes?.channels ?? []).map((channel) => ({
          displayName: channel.displayName,
          server: channel.server,
        })),
        plugin: plugin.manifest.name,
        themes: (plugin.runtimes?.themes ?? []).map((theme) => exportTheme(theme)),
        workflows: (plugin.runtimes?.workflows ?? []).map((workflow) => exportWorkflow(workflow)),
      }));
      await ctx.session.synthetic({
        resume: false,
        sessionID,
        text: JSON.stringify(exports, undefined, 2),
      });
    },
    name: "agent-plugins-export",
  });
};

export type { MonitorRuntime };
export { addMonitorCommand, addRuntimeExportCommand, addStyleCommand };
