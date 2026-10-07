import type { Plugin } from "@opencode/plugin";

import type { Options } from "#src/options.ts";
import { registerHooks } from "#src/runtime/hooks.ts";
import type { LoadResult, Report } from "#src/types.ts";

const registerConfiguredHooks = async (
  ctx: Plugin.Context,
  options: Options,
  current: () => LoadResult,
  report: Report,
) =>
  registerHooks(ctx, () => current().plugins.flatMap((plugin) => plugin.hooks ?? []), {
    enabled: (hook) =>
      current().plugins.some(
        (plugin) =>
          plugin.root === hook.root && options.trustedHooks.includes(plugin.manifest.name),
      ),
    env: (hook) => {
      const plugin = current().plugins.find((entry) => entry.root === hook.root);
      return plugin === undefined
        ? {}
        : {
            CLAUDE_PLUGIN_DATA: plugin.dataDir,
            CLAUDE_PLUGIN_ROOT: plugin.root,
            CLAUDE_PROJECT_DIR: ctx.location.project.directory,
            PLUGIN_DATA: plugin.dataDir,
            PLUGIN_ROOT: plugin.root,
            ...plugin.configuration?.hookEnvironment(),
          };
    },
    report,
  });

export { registerConfiguredHooks };
