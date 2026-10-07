import { homedir } from "node:os";

import type { Plugin } from "@opencode/plugin";
import type { CommandEditor } from "@opencode/plugin/promise/command";

import { errorOutput } from "#src/cli/errors.ts";
import { runCli } from "#src/cli/run.ts";
import { managerArguments } from "#src/runtime/manager-arguments.ts";
import { safeNativeError } from "#src/runtime/manager-errors.ts";

const QUOTE_ERROR =
  "Unterminated quote or trailing escape. Run /agent-plugins-manage --help to check usage.";
const SESSION_ERROR =
  "Unable to read the invoking session location. Retry when the session is available.";

const runManager = async (argv: readonly string[], directory: string): Promise<string> => {
  const output: string[] = [];
  try {
    const exitCode = await runCli(argv, {
      cwd: directory,
      // oxlint-disable-next-line node/no-process-env -- command invocation is the CLI environment boundary
      env: process.env,
      home: homedir(),
      stderr: (text) => {
        output.push(safeNativeError(new Error(text)));
      },
      stdout: (text) => {
        output.push(text);
      },
    });
    if (exitCode !== 0 && !argv.includes("--json")) {
      output.push(
        `Exit status: ${exitCode}. Run /agent-plugins-manage doctor in the same scope to inspect problems.`,
      );
    }
  } catch (error) {
    const message = safeNativeError(error);
    output.push(errorOutput(argv, new Error(message)));
  }
  return output.join("\n");
};

const addManagerCommand = (ctx: Plugin.Context, editor: CommandEditor) => {
  editor.add({
    description: "Manage Agent Plugins using CLI arguments; does not rescan the running plugin",
    async execute({ prompt, sessionID }) {
      let argv: string[];
      try {
        argv = managerArguments(prompt.text);
      } catch {
        await ctx.session.synthetic({
          resume: false,
          sessionID,
          text: errorOutput(
            /(?:^|\s)--json(?=\s|$)/u.test(prompt.text) ? ["--json"] : [],
            new Error(QUOTE_ERROR),
          ),
        });
        return;
      }
      let directory: string;
      try {
        const { location } = await ctx.session.get({ sessionID });
        ({ directory } = location);
      } catch {
        await ctx.session.synthetic({
          resume: false,
          sessionID,
          text: errorOutput(argv, new Error(SESSION_ERROR)),
        });
        return;
      }
      const text = await runManager(argv, directory);
      await ctx.session.synthetic({ resume: false, sessionID, text });
    },
    name: "agent-plugins-manage",
  });
};

export { addManagerCommand };
