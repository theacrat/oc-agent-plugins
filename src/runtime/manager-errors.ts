import { validateName } from "#src/manager/paths.ts";

const GENERIC_ERROR = "Manager command failed. Run /agent-plugins-manage --help to check usage.";
const SAFE_MESSAGES = new Set([
  "Too many positional arguments",
  "Use --global or --project, not both",
  "Use update <name> or update --all",
  "--all is only supported for update",
  "--ref and --subdir are install options; update uses the recorded source",
  "--ref and --subdir require a Git source",
  "Source ref and --ref disagree",
  "Local source must be a directory",
  "Source must not be empty or contain NUL",
  "Source and store directories must not overlap",
  "Filesystem root cannot be a plugin source",
]);
const ERROR_RULES: readonly (readonly [RegExp, string])[] = [
  [/^Unknown command /u, "Unknown command. Run /agent-plugins-manage --help to check usage."],
  [
    /^Unknown option /u,
    "Unknown option. Run /agent-plugins-manage --help to check supported flags.",
  ],
  [/^Option /u, "Invalid option value. Run /agent-plugins-manage --help to check usage."],
  [/^Unsafe plugin name:/u, "Unsafe plugin name. Use a portable plugin name, not a path."],
  [
    /^(?:install|info|enable|disable|uninstall) requires (?:a source|a plugin name)$/u,
    "Missing required source or plugin name. Run /agent-plugins-manage --help.",
  ],
  [
    /^(?:list|doctor|help|version) does not take a plugin name$/u,
    "This command does not take a plugin name. Run /agent-plugins-manage --help.",
  ],
  [
    /^(?:Unsafe |Opened source file escaped|Source path changed)/u,
    "Unsafe source or installation path. Use real, contained directories without symlinks or reserved paths.",
  ],
  [
    /^(?:Unsupported Git URL|Public Git sources require|File Git URLs must)/u,
    "Unsupported Git source. Use a supported HTTPS or SSH URL without credentials or query strings.",
  ],
  [
    /^(?:Unowned or edited snapshot:|Edited staging snapshot retained|Refusing to modify )/u,
    "Installation has local edits or is unmanaged. Preserve local work and inspect it before retrying; retained staging data must not be deleted blindly.",
  ],
  [
    /^Store is locked:/u,
    "Store is locked. Inspect the owner and wait for active operations before recovering the lock.",
  ],
  [
    /^(?:Interrupted transaction detected;|Rollback collision;|Staging directory replaced;)/u,
    "Interrupted or conflicting transaction. Inspect the retained journal and staging data and recover owned paths before retrying.",
  ],
  [
    /^(?:Missing or conflicting installation:|Cannot update |Cannot update this scope:)/u,
    "Installation is missing, conflicting, edited or unmanaged. Run /agent-plugins-manage doctor in the same scope and preserve local work.",
  ],
  [
    /^(?:Installation already exists:|Installation collision:|Transaction backup already exists)/u,
    "Installation or backup already exists. Inspect the same scope with list and doctor before retrying.",
  ],
  [
    /^(?:No supported root plugin manifest found|Invalid (?:agent-plugins|claude|codex|cursor) manifest:|Source has no supported plugin manifest)/u,
    "Source has no valid supported plugin manifest. Check the package root and manifest before retrying.",
  ],
  [
    /^Git acquisition (?:failed|exceeded runtime limit)$/u,
    "Git acquisition failed or timed out. Check source access and connectivity before retrying.",
  ],
];

const safeNativeError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return GENERIC_ERROR;
  }
  // URL contents never reach a formatter, including rejected sources with embedded credentials.
  const message = error.message.replaceAll(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/gu,
    "[redacted URL]",
  );
  if (SAFE_MESSAGES.has(message)) {
    return message;
  }
  const missing = /^Plugin "(?<name>[^"]+)" is not installed in this scope$/u.exec(message);
  const name = missing?.groups?.["name"];
  if (name !== undefined) {
    try {
      validateName(name);
      return `Plugin "${name}" is not installed in this scope`;
    } catch {
      return GENERIC_ERROR;
    }
  }
  return ERROR_RULES.find(([pattern]) => pattern.test(message))?.[1] ?? GENERIC_ERROR;
};

export { safeNativeError };
