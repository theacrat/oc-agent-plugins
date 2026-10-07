import type { CommandSyntax } from "#src/types.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";

// How each vendor lays out a plugin. Everything format-specific lives in this table.
interface FormatSpec {
  readonly manifest: string;
  // Claude Code loads a marketplace-listed plugin with no manifest; Codex and Cursor require one.
  readonly manifestOptional: boolean;
  readonly marketplace?: string;
  readonly mcpDefaults: readonly string[];
  // A declared `mcpServers` replaces the default file (Cursor) or merges after it (Claude, Codex).
  readonly mcpDeclaredReplaces: boolean;
  // A declared `skills` replaces `skills/` (Cursor) or adds to it (Claude, Codex).
  readonly skillsDeclaredReplaces: boolean;
  // How command templates expand arguments, or false when the format has no commands.
  readonly commands: CommandSyntax | false;
  readonly rules: boolean;
  // Markdown agents in `agents/` (or declared `agents` paths, which replace the default).
  readonly agents: boolean;
  // Fields this plugin can't map to OpenCode; reported so users see what's missing.
  readonly unsupported: readonly string[];
  readonly unsupportedDirs: readonly string[];
}

const SPECS: Readonly<Record<VendorFormat, FormatSpec>> = {
  claude: {
    agents: true,
    commands: "claude",
    manifest: ".claude-plugin/plugin.json",
    manifestOptional: true,
    marketplace: ".claude-plugin/marketplace.json",
    mcpDeclaredReplaces: false,
    mcpDefaults: [".mcp.json"],
    rules: false,
    skillsDeclaredReplaces: false,
    unsupported: [
      "hooks",
      "lspServers",
      "outputStyles",
      "workflows",
      "userConfig",
      "channels",
      "experimental",
    ],
    unsupportedDirs: ["hooks", "output-styles", "monitors"],
  },
  codex: {
    agents: false,
    commands: false,
    manifest: ".codex-plugin/plugin.json",
    manifestOptional: false,
    mcpDeclaredReplaces: false,
    mcpDefaults: [".mcp.json"],
    rules: false,
    skillsDeclaredReplaces: false,
    unsupported: ["hooks", "apps"],
    unsupportedDirs: ["hooks"],
  },
  cursor: {
    agents: true,
    commands: "plain",
    manifest: ".cursor-plugin/plugin.json",
    manifestOptional: false,
    marketplace: ".cursor-plugin/marketplace.json",
    mcpDeclaredReplaces: true,
    mcpDefaults: ["mcp.json"],
    rules: true,
    skillsDeclaredReplaces: true,
    unsupported: ["hooks", "variables"],
    unsupportedDirs: ["hooks"],
  },
};

export type { FormatSpec };
export { SPECS };
