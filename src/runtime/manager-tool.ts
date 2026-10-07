import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";

import { parseArguments } from "#src/cli/arguments.ts";
import { errorOutput } from "#src/cli/errors.ts";
import type { JsonRecord } from "#src/json.ts";
import { isRecord } from "#src/json.ts";
import { safeNativeError } from "#src/runtime/manager-errors.ts";
import { resourceScope } from "#src/runtime/resources.ts";

const ACTIONS = ["install", "update", "list", "info", "enable", "disable", "uninstall", "doctor"];
const FIELDS = new Set(["action", "name", "source", "global", "ref", "subdir", "all"]);
const NAME_ACTIONS = new Set(["update", "info", "enable", "disable", "uninstall"]);
const NAME = "agent_plugins_manage";

const validateFields = (input: JsonRecord) => {
  for (const key of ["name", "source", "ref", "subdir"]) {
    if (key in input && (typeof input[key] !== "string" || input[key].length === 0)) {
      throw new Error("Option string values must be nonempty strings");
    }
  }
  for (const key of ["global", "all"]) {
    if (key in input && typeof input[key] !== "boolean") {
      throw new Error("Option flags must be booleans");
    }
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
  parseArguments(argv);
  return argv;
};

const executeManagerTool = (input: unknown, context: ToolContext) => {
  try {
    managerToolArguments(input);
    context.signal.throwIfAborted();
    // OpenCode 2.0.24 filters denied tool definitions but does not request approval before execution.
    // Its plugin context exposes neither permission creation nor forms, so do not dispatch without a gate.
    return {
      content: errorOutput(
        ["--json"],
        new Error(
          "Agent package management is unavailable because this OpenCode plugin SDK cannot request user approval. Ask the user to run /agent-plugins-manage with the desired action and scope.",
        ),
      ),
    };
  } catch (error) {
    return { content: errorOutput(["--json"], new Error(safeNativeError(error))) };
  }
};

const registerManagerTool = async (ctx: Plugin.Context) => {
  const scope = resourceScope();
  try {
    scope.own(
      await ctx.permission.hook("evaluate", (event) => {
        if (event.action === NAME && event.effect === "allow") {
          event.effect = "ask";
          event.message =
            "Approve Agent Plugins package management, including reads. This does not grant trust or rescan runtime components.";
        }
      }),
    );
    scope.own(
      await ctx.tool.transform((editor) => {
        editor.add({
          description:
            "Agent package management is blocked until the plugin SDK supports user approval. Ask the user to run /agent-plugins-manage instead.",
          execute: async (input: unknown, context) => {
            await Promise.resolve();
            return executeManagerTool(input, context);
          },
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
