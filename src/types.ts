import type { LspDefinition } from "#src/vendor/lsp.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

// Detection order: the first enabled format with a manifest claims a directory.
const FORMATS = ["agent-plugins", "claude", "codex", "cursor"] as const;
type Format = (typeof FORMATS)[number];

const COMPONENTS = ["skills", "mcp", "commands", "rules", "agents"] as const;
type Component = (typeof COMPONENTS)[number];

interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly source: string;
  readonly message: string;
}

interface Author {
  readonly name?: string;
  readonly email?: string;
  readonly url?: string;
}

interface Manifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: Author;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
}

interface PluginSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly content: string;
  // false hides the skill from the model's list (Claude's `disable-model-invocation: true`).
  readonly autoinvoke?: boolean;
}

// `claude` follows Claude Code: 0-based `$N`, `$ARGUMENTS[N]`, named `arguments`, `!`cmd`` injection.
// `plain` follows OpenCode's own Markdown commands: `$ARGUMENTS` and 1-based `$N`.
type CommandSyntax = "claude" | "plain";

interface PluginCommand {
  readonly name: string;
  readonly description?: string;
  readonly template: string;
  readonly syntax: CommandSyntax;
  readonly arguments: readonly string[];
}

interface PluginRule {
  readonly name: string;
  readonly description?: string;
  readonly alwaysApply: boolean;
  readonly globs: readonly string[];
  readonly path: string;
  readonly content: string;
}

interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "ask" | "deny";
}

interface PluginAgent {
  readonly name: string;
  readonly description?: string;
  readonly system: string;
  readonly mode: "primary" | "subagent" | "all";
  // `provider/model`; vendor aliases like `sonnet` or `inherit` aren't OpenCode models and are dropped.
  readonly model?: string;
  readonly color?: string;
  readonly steps?: number;
  readonly permissions: readonly PermissionRule[];
}

interface StdioServer {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

interface StreamableHttpServer {
  readonly type: "streamable-http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

type PluginServer = StdioServer | StreamableHttpServer;

interface AgentPlugin {
  readonly lsp?: Readonly<Record<string, LspDefinition>>;
  readonly format: Format;
  readonly manifest: Manifest;
  readonly root: string;
  readonly dataDir: string;
  readonly skills: readonly PluginSkill[];
  readonly servers: Readonly<Record<string, PluginServer>>;
  readonly commands: readonly PluginCommand[];
  readonly rules: readonly PluginRule[];
  readonly agents: readonly PluginAgent[];
}

interface LoadResult {
  readonly plugins: readonly AgentPlugin[];
  readonly diagnostics: readonly Diagnostic[];
}

type Report = (diagnostic: Diagnostic) => void;

export type {
  AgentPlugin,
  Author,
  CommandSyntax,
  Component,
  Diagnostic,
  Format,
  LoadResult,
  Manifest,
  PermissionRule,
  PluginAgent,
  PluginCommand,
  PluginRule,
  PluginServer,
  PluginSkill,
  Report,
  StdioServer,
  StreamableHttpServer,
};
export { COMPONENTS, FORMATS, MCP_SCHEMA, PLUGIN_SCHEMA };
