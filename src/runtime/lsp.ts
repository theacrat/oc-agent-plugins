import type { Plugin } from "@opencode/plugin";
import type { CommandEditor } from "@opencode/plugin/promise/command";

import type { LoadResult } from "#src/types.ts";

const addLspExportCommand = (
  ctx: Plugin.Context,
  editor: CommandEditor,
  current: () => LoadResult,
) => {
  editor.add({
    description: "Show a native LSP config fragment without modifying project or global settings",
    async execute({ sessionID }) {
      const servers = Object.fromEntries(
        current().plugins.flatMap((plugin) =>
          Object.entries(plugin.lsp ?? {}).map(([name, definition]) => [
            `${plugin.manifest.name}-${name}`,
            definition,
          ]),
        ),
      );
      await ctx.session.synthetic({
        resume: false,
        sessionID,
        text: `Merge this fragment into your project opencode.json(c) to enable imported language servers. No configuration was changed.\n\n${JSON.stringify({ lsp: servers }, undefined, 2)}`,
      });
    },
    name: "agent-plugins-lsp",
  });
};

export { addLspExportCommand };
