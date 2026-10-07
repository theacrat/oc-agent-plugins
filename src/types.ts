const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

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
  readonly manifest: Manifest;
  readonly root: string;
  readonly dataDir: string;
  readonly skills: readonly PluginSkill[];
  readonly servers: Readonly<Record<string, PluginServer>>;
}

interface LoadResult {
  readonly plugins: readonly AgentPlugin[];
  readonly diagnostics: readonly Diagnostic[];
}

export type {
  Diagnostic,
  Author,
  Manifest,
  PluginSkill,
  StdioServer,
  StreamableHttpServer,
  PluginServer,
  AgentPlugin,
  LoadResult,
};
export { PLUGIN_SCHEMA, MCP_SCHEMA };
