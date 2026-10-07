import { homedir } from "node:os";

import type { Plugin } from "@opencode/plugin";
import type { CommandEditor } from "@opencode/plugin/promise/command";

import { errorOutput } from "#src/cli/errors.ts";
import { runCli } from "#src/cli/run.ts";
import { managerArguments } from "#src/runtime/manager-arguments.ts";

const addManagerCommand = (ctx: Plugin.Context, editor: CommandEditor) => {
  editor.add({
    description: "Manage Agent Plugins using CLI arguments; does not rescan the running plugin",
    async execute({ prompt, sessionID }) {
      const output: string[] = [];
      let argv: string[] = [];
      try {
        argv = managerArguments(prompt.text);
        const session = await ctx.session.get({ sessionID });
        await runCli(argv, {
          cwd: session.location.directory,
          // oxlint-disable-next-line node/no-process-env -- command invocation is the CLI environment boundary
          env: process.env,
          home: homedir(),
          stderr: (text) => {
            output.push(text);
          },
          stdout: (text) => {
            output.push(text);
          },
        });
      } catch {
        // Exceptions may contain source credentials, arguments, or SDK response bodies.
        output.push(
          errorOutput(argv, new Error("Manager command failed; check arguments and package state")),
        );
      }
      await ctx.session.synthetic({ resume: false, sessionID, text: output.join("\n") });
    },
    name: "agent-plugins-manage",
  });
};

export { addManagerCommand };
