import type { Arguments } from "#src/cli/arguments.ts";
import type { Installation } from "#src/manager/types.ts";

interface Manager {
  readonly install: (source: string, args: Arguments) => Promise<Installation>;
  readonly update: (name: string) => Promise<Installation>;
  readonly list: () => Promise<readonly Installation[]>;
  readonly enable: (name: string, enabled: boolean) => Promise<Installation>;
  readonly remove: (name: string) => Promise<void>;
  readonly doctor: () => Promise<{
    readonly installations: readonly Installation[];
    readonly problems: readonly string[];
  }>;
}

interface Result {
  readonly command: string;
  readonly entries: readonly Installation[];
  readonly message?: string;
  readonly problems?: readonly string[];
  readonly exitCode: number;
}

const named = async (manager: Manager, name: string): Promise<Installation> => {
  const entries = await manager.list();
  const found = entries.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`Plugin "${name}" is not installed in this scope`);
  }
  return found;
};

const updateTargets = async (args: Arguments, manager: Manager): Promise<Result> => {
  if (args.all) {
    const diagnosis = await manager.doctor();
    if (diagnosis.problems.length > 0) {
      throw new Error(`Cannot update this scope: ${diagnosis.problems.join("; ")}`);
    }
  }
  const inventory = await manager.list();
  const entries = args.all
    ? inventory.filter((entry) => entry.managed)
    : [await named(manager, args.target ?? "")];
  const updated: Installation[] = [];
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- scope-wide locking makes parallel mutations conflict
    updated.push(await manager.update(entry.name));
  }
  return {
    command: "update",
    entries: updated,
    exitCode: 0,
    message: "Updated managed snapshots. Run /agent-plugins in OpenCode to rescan.",
  };
};

const diagnose = async (manager: Manager): Promise<Result> => {
  const diagnosis = await manager.doctor();
  return {
    command: "doctor",
    entries: diagnosis.installations,
    exitCode: diagnosis.problems.length > 0 ? 1 : 0,
    problems: diagnosis.problems,
  };
};

const execute = async (args: Arguments, manager: Manager): Promise<Result> => {
  const { command, target = "" } = args;
  switch (command) {
    case "install": {
      return {
        command,
        entries: [await manager.install(target, args)],
        exitCode: 0,
        message: "Installed snapshot. Run /agent-plugins in OpenCode to rescan.",
      };
    }
    case "update": {
      return updateTargets(args, manager);
    }
    case "list": {
      return { command, entries: await manager.list(), exitCode: 0 };
    }
    case "info": {
      return { command, entries: [await named(manager, target)], exitCode: 0 };
    }
    case "enable":
    case "disable": {
      return {
        command,
        entries: [await manager.enable(target, command === "enable")],
        exitCode: 0,
      };
    }
    case "uninstall": {
      await manager.remove(target);
      return {
        command,
        entries: [],
        exitCode: 0,
        message: `Removed ${target}. Persistent plugin data was retained.`,
      };
    }
    case "doctor": {
      return diagnose(manager);
    }
    case "help":
    case "version": {
      throw new Error("Help and version commands do not use the installation manager");
    }
  }
};

export type { Manager, Result };
export { execute };
