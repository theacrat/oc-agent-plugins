import packageInfo from "oc-agent-plugins/package.json";

import { parseArguments } from "#src/cli/arguments.ts";
import type { CliContext } from "#src/cli/context.ts";
import { execute } from "#src/cli/execute.ts";
import { HELP } from "#src/cli/help.ts";
import { locations } from "#src/cli/locations.ts";
import { infoOutput, listOutput } from "#src/cli/output.ts";
import { createManager } from "#src/manager/operations.ts";

const runCli = async (argv: readonly string[], context: CliContext): Promise<number> => {
  const { version } = packageInfo;
  const args = parseArguments(argv);
  if (args.command === "help") {
    context.stdout(args.json ? JSON.stringify({ command: "help", help: HELP }) : HELP);
    return 0;
  }
  if (args.command === "version") {
    context.stdout(args.json ? JSON.stringify({ version }) : version);
    return 0;
  }
  const location = locations(args, context.cwd, context.home, context.env);
  const manager = createManager(location.root, context.cwd);
  const result = await execute(args, manager);
  if (args.json) {
    context.stdout(
      JSON.stringify({ ...result, root: location.root, scope: location.scope }, undefined, 2),
    );
  } else {
    context.stdout(
      args.command === "info" && result.entries[0] !== undefined
        ? infoOutput(result.entries[0])
        : listOutput(result.entries, location.root),
    );
    if (result.message !== undefined) {
      context.stdout(result.message);
    }
    for (const problem of result.problems ?? []) {
      context.stderr(problem);
    }
  }
  return result.exitCode;
};

export { runCli };
