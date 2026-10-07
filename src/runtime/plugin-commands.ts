import type { Plugin } from "@opencode/plugin";

import { forwardAttachments } from "#src/attachments.ts";
import { formatStatus, toCommands } from "#src/opencode.ts";
import type { Options } from "#src/options.ts";
import { commandInjectionForPlugin } from "#src/options.ts";
import type { registerCompatibility } from "#src/runtime/compatibility.ts";
import { addLspExportCommand } from "#src/runtime/lsp.ts";
import { addManagerCommand } from "#src/runtime/manager-command.ts";
import { describeInjections, injectShell, shellRunner } from "#src/shell.ts";
import { renderCommand } from "#src/template.ts";
import type { Rendered } from "#src/template.ts";
import type { LoadResult } from "#src/types.ts";

type Context = Plugin.Context;
interface State {
  current: LoadResult;
}
const runShell = shellRunner("/bin/sh");

const registerCommands = async (
  ctx: Context,
  options: Options,
  state: State,
  reload: () => Promise<void>,
  compatibility: Awaited<ReturnType<typeof registerCompatibility>>,
) => {
  // Only Claude-format templates contain `!`cmd`` injections; others render with an empty list.
  const expandShell = async (rendered: Rendered, sessionID: string, plugin: string) => {
    if (rendered.shell.length === 0 || !commandInjectionForPlugin(options, plugin)) {
      return describeInjections(rendered);
    }
    const session = await ctx.session.get({ sessionID });
    return injectShell(rendered, session.location.directory, AbortSignal.timeout(60_000), runShell);
  };
  await ctx.command.transform((editor) => {
    compatibility.addCommands(editor);
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
    for (const plugin of state.current.plugins) {
      for (const { command, name } of toCommands(plugin)) {
        editor.add({
          ...(command.description === undefined ? {} : { description: command.description }),
          async execute({ delivery, prompt, sessionID }) {
            const text = await expandShell(
              renderCommand(command, prompt.text),
              sessionID,
              plugin.manifest.name,
            );
            await ctx.session.prompt({ delivery, sessionID, text, ...forwardAttachments(prompt) });
          },
          name,
        });
      }
    }
    addManagerCommand(ctx, editor);
  });
};

export { registerCommands };
