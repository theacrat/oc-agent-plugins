import type { Format } from "#src/types.ts";

type VendorFormat = Exclude<Format, "agent-plugins">;

interface Placeholders {
  // Expands this vendor's placeholders in a single pass; substituted text is never rescanned.
  readonly expand: (value: string) => string;
  // Expands only plugin path placeholders (plus `extra`) in skill and command bodies.
  readonly expandContent: (value: string, extra?: Readonly<Record<string, string>>) => string;
  // Whether `url` and `headers` are expanded too (Claude Code does, Codex and Cursor don't).
  readonly expandRemote: boolean;
  // Variables a stdio server receives in its environment.
  readonly processEnv: Readonly<Record<string, string>>;
}

interface PlaceholderInput {
  readonly root: string;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// Variable names each vendor substitutes for the plugin root and data directory.
const NAMES: Readonly<
  Record<VendorFormat, { readonly root: readonly string[]; readonly data: readonly string[] }>
> = {
  claude: { data: ["CLAUDE_PLUGIN_DATA"], root: ["CLAUDE_PLUGIN_ROOT"] },
  codex: {
    data: ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"],
    root: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
  },
  cursor: { data: [], root: ["CURSOR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"] },
};

const PLACEHOLDER = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu;

const placeholdersFor = (format: VendorFormat, input: PlaceholderInput): Placeholders => {
  const names = NAMES[format];
  const known = new Map<string, string>([
    ...names.root.map((name) => [name, input.root] as const),
    ...names.data.map((name) => [name, input.dataDir] as const),
  ]);
  // Claude Code also expands process environment variables, with `${VAR:-default}`.
  const fromEnv = format === "claude";
  const resolve = (match: RegExpExecArray) => {
    const name = match.groups?.["name"] ?? "";
    const plugin = known.get(name);
    if (plugin !== undefined) {
      return plugin;
    }
    if (!fromEnv) {
      return match[0];
    }
    return input.env[name] ?? match.groups?.["fallback"] ?? match[0];
  };
  // Built from matchAll so substituted text is never rescanned for placeholders.
  const expand = (value: string) => {
    let output = "";
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      output += value.slice(last, match.index) + resolve(match);
      last = match.index + match[0].length;
    }
    return output + value.slice(last);
  };
  // Markdown bodies only get the plugin paths, never process environment values, which could be secrets.
  const expandContent = (value: string, extra: Readonly<Record<string, string>> = {}) => {
    let output = "";
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      const name = match.groups?.["name"] ?? "";
      const replacement = extra[name] ?? known.get(name);
      if (replacement === undefined || match.groups?.["fallback"] !== undefined) {
        continue;
      }
      output += value.slice(last, match.index) + replacement;
      last = match.index + match[0].length;
    }
    return output + value.slice(last);
  };
  return {
    expand,
    expandContent,
    expandRemote: format === "claude",
    processEnv: Object.fromEntries(known),
  };
};

export type { PlaceholderInput, Placeholders, VendorFormat };
export { placeholdersFor };
