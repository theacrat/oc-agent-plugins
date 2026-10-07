import path from "node:path";

import type { Arguments } from "#src/cli/arguments.ts";
import { configDirectory } from "#src/options.ts";

interface Locations {
  readonly root: string;
  readonly project: string;
  readonly scope: "global" | "project";
}

const locations = (
  args: Arguments,
  cwd: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Locations => {
  const project = path.resolve(cwd, args.project ?? ".");
  return {
    project,
    root: args.global
      ? path.resolve(configDirectory(home, env), "agent-plugins")
      : path.join(project, ".opencode", "agent-plugins"),
    scope: args.global ? "global" : "project",
  };
};

export type { Locations };
export { locations };
