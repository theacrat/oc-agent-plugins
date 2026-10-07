import { homedir } from "node:os";

import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";

import { parseArguments } from "#src/cli/arguments.ts";
import { errorOutput } from "#src/cli/errors.ts";
import { runCli } from "#src/cli/run.ts";
import type { JsonRecord } from "#src/json.ts";
import { isRecord } from "#src/json.ts";
import { validateGitSource } from "#src/manager/source-policy.ts";
import { safeNativeError } from "#src/runtime/manager-errors.ts";
import { resourceScope } from "#src/runtime/resources.ts";

const ACTIONS = ["install", "update", "list", "info", "enable", "disable", "uninstall", "doctor"];
const FIELDS = new Set(["action", "name", "source", "global", "ref", "subdir", "all"]);
const NAME_ACTIONS = new Set(["update", "info", "enable", "disable", "uninstall"]);
const NAME = "agent_plugins_manage";

const hasControls = (text: string): boolean => {
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 32 || point === 127) {
      return true;
    }
  }
  return false;
};

const validateFields = (input: JsonRecord) => {
  for (const key of ["name", "source", "ref", "subdir"]) {
    if (
      key in input &&
      (typeof input[key] !== "string" ||
        input[key].length === 0 ||
        input[key].length > 4096 ||
        hasControls(input[key]))
    ) {
      throw new Error("Option string values must be nonempty strings");
    }
  }
  for (const key of ["global", "all"]) {
    if (key in input && typeof input[key] !== "boolean") {
      throw new Error("Option flags must be booleans");
    }
  }
};

const validateRemoteTarget = (args: ReturnType<typeof parseArguments>) => {
  const { target, ref, subdir } = args;
  if (
    args.command === "install" &&
    target !== undefined &&
    (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("git@"))
  ) {
    const [url = "", fragment] = target.split("#");
    const selection = ref ?? fragment;
    validateGitSource({
      kind: "git",
      url,
      ...(selection === undefined ? {} : { ref: selection }),
      ...(subdir === undefined ? {} : { subdir }),
    });
  }
};

const managerToolArguments = (input: unknown): string[] => {
  if (!isRecord(input) || Object.keys(input).some((key) => !FIELDS.has(key))) {
    throw new Error("Option input must be a closed management object");
  }
  validateFields(input);
  const { action, name, source, global, ref, subdir, all } = input;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new Error("Unknown command");
  }
  if (
    ("source" in input && action !== "install") ||
    ("name" in input && !NAME_ACTIONS.has(action))
  ) {
    throw new Error("Option source or name is not supported for this action");
  }
  if ("all" in input && action !== "update") {
    throw new Error("--all is only supported for update");
  }
  const argv = [action, "--json"];
  if (global === true) {
    argv.push("--global");
  }
  if (all === true) {
    argv.push("--all");
  }
  if (typeof ref === "string") {
    argv.push(`--ref=${ref}`);
  }
  if (typeof subdir === "string") {
    argv.push(`--subdir=${subdir}`);
  }
  const target = action === "install" ? source : name;
  if (typeof target === "string") {
    argv.push("--", target);
  }
  validateRemoteTarget(parseArguments(argv));
  return argv;
};

const requestApproval = async (
  ctx: Plugin.Context,
  argv: readonly string[],
  context: ToolContext,
): Promise<boolean> => {
  const tools = await ctx.tool.list();
  const question = tools.find((tool) => tool.id === "question");
  if (question === undefined) {
    return false;
  }
  context.signal.throwIfAborted();
  const operation = JSON.stringify(argv);
  const result = await question.execute(
    {
      questions: [
        {
          header: "Package approval",
          multiple: false,
          options: [
            { description: "Do not run this package management operation", label: "Reject" },
            {
              description: "Run this exact operation once in the invoking session's scope",
              label: "Approve",
            },
          ],
          question: `Approve Agent Plugins management ${operation}? Global scope uses the configured global directory; otherwise scope is the invoking session. This does not grant trust or rescan runtime components.`,
        },
      ],
    },
    context,
  );
  const output: unknown = result.output;
  return (
    isRecord(output) &&
    Array.isArray(output["answers"]) &&
    output["answers"].length === 1 &&
    Array.isArray(output["answers"][0]) &&
    output["answers"][0].length === 1 &&
    output["answers"][0][0] === "Approve"
  );
};

const dispatchManager = async (argv: readonly string[], directory: string) => {
  const output: string[] = [];
  await runCli(argv, {
    cwd: directory,
    // oxlint-disable-next-line node/no-process-env -- tool invocation is the CLI environment boundary
    env: process.env,
    home: homedir(),
    stderr: (text) => {
      const message = safeNativeError(new Error(text));
      output.push(errorOutput(["--json"], new Error(message)));
    },
    stdout: (text) => {
      output.push(text);
    },
  });
  return { content: output.join("\n") };
};

const executeManagerTool = async (ctx: Plugin.Context, input: unknown, context: ToolContext) => {
  try {
    const argv = managerToolArguments(input);
    context.signal.throwIfAborted();
    // The native question executor asserts its permission and waits for a user form reply.
    // Tool options only filter denied definitions; they are not an approval gate in SDK 2.0.24.
    if (!(await requestApproval(ctx, argv, context))) {
      return {
        content: errorOutput(
          ["--json"],
          new Error(
            "Package management was not approved or the native question tool is unavailable. Ask the user to run /agent-plugins-manage instead.",
          ),
        ),
      };
    }
    context.signal.throwIfAborted();
    let directory: string;
    try {
      const { location } = await ctx.session.get({ sessionID: context.sessionID });
      ({ directory } = location);
    } catch {
      return {
        content: errorOutput(
          ["--json"],
          new Error(
            "Unable to read the invoking session location. Retry when the session is available.",
          ),
        ),
      };
    }
    context.signal.throwIfAborted();
    return await dispatchManager(argv, directory);
  } catch (error) {
    return { content: errorOutput(["--json"], new Error(safeNativeError(error))) };
  }
};

const registerManagerTool = async (ctx: Plugin.Context) => {
  const scope = resourceScope();
  try {
    scope.own(
      await ctx.tool.transform((editor) => {
        editor.add({
          description:
            "Manage Agent Plugins packages after explicit user approval through the native question tool. Does not grant trust or rescan runtime components.",
          execute: async (input: unknown, context) => executeManagerTool(ctx, input, context),
          input: {
            additionalProperties: false,
            properties: {
              action: { enum: ACTIONS, type: "string" },
              all: { type: "boolean" },
              global: { type: "boolean" },
              name: { type: "string" },
              ref: { type: "string" },
              source: { type: "string" },
              subdir: { type: "string" },
            },
            required: ["action"],
            type: "object",
          },
          name: NAME,
          options: { codemode: true, permission: NAME },
        });
      }),
    );
    return scope;
  } catch (error) {
    await scope.dispose();
    throw error;
  }
};

export { registerManagerTool };
