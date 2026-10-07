import { parseArgs } from "node:util";

type Command =
  | "install"
  | "update"
  | "list"
  | "info"
  | "enable"
  | "disable"
  | "uninstall"
  | "doctor"
  | "help"
  | "version";

interface Arguments {
  readonly command: Command;
  readonly target?: string;
  readonly global: boolean;
  readonly project?: string;
  readonly json: boolean;
  readonly all: boolean;
  readonly ref?: string;
  readonly subdir?: string;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  disable: "disable",
  doctor: "doctor",
  enable: "enable",
  help: "help",
  info: "info",
  install: "install",
  list: "list",
  remove: "uninstall",
  uninstall: "uninstall",
  update: "update",
  version: "version",
};

const validateArguments = (args: Arguments, count: number) => {
  const { command, target } = args;
  if (count > 2) {
    throw new Error("Too many positional arguments");
  }
  if (args.global && args.project !== undefined) {
    throw new Error("Use --global or --project, not both");
  }
  if (
    ["install", "info", "enable", "disable", "uninstall"].includes(command) &&
    target === undefined
  ) {
    throw new Error(`${command} requires ${command === "install" ? "a source" : "a plugin name"}`);
  }
  if (command === "update" && (target === undefined) === !args.all) {
    throw new Error("Use update <name> or update --all");
  }
  if (args.all && command !== "update") {
    throw new Error("--all is only supported for update");
  }
  if ((args.ref !== undefined || args.subdir !== undefined) && command !== "install") {
    throw new Error("--ref and --subdir are install options; update uses the recorded source");
  }
  if (["list", "doctor", "help", "version"].includes(command) && target !== undefined) {
    throw new Error(`${command} does not take a plugin name`);
  }
  if (
    args.target !== undefined &&
    args.command !== "install" &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(args.target) || args.target.includes(".."))
  ) {
    throw new Error("Plugin names must be safe directory names, not paths");
  }
};

const parseArguments = (argv: readonly string[]): Arguments => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      all: { type: "boolean" },
      global: { short: "g", type: "boolean" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      project: { short: "p", type: "string" },
      ref: { type: "string" },
      subdir: { type: "string" },
      version: { short: "v", type: "boolean" },
    },
    strict: true,
  });
  const [word = "help", target] = positionals;
  let command = COMMANDS[word];
  if (values.help) {
    command = "help";
  }
  if (values.version) {
    command = "version";
  }
  if (command === undefined) {
    throw new Error(`Unknown command "${word}". Run oc-agent-plugins --help.`);
  }
  const parsed = {
    all: values.all === true,
    command,
    global: values.global === true,
    json: values.json === true,
    ...(target === undefined ? {} : { target }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.ref === undefined ? {} : { ref: values.ref }),
    ...(values.subdir === undefined ? {} : { subdir: values.subdir }),
  };
  validateArguments(parsed, positionals.length);
  return parsed;
};

export type { Arguments, Command };
export { parseArguments };
