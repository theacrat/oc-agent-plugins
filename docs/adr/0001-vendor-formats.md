# ADR 0001: Claude Code, Codex and Cursor plugin formats

## Status

Accepted.

## Context

Most published plugins aren't Agent Plugins yet. The 66 installed plugins on this machine use `.claude-plugin/` (Claude Code) and `.codex-plugin/` (Codex), and only cloudflare/skills also ships a root `plugin.json`. Cursor has its own `.cursor-plugin/` format. Users want those plugins in OpenCode, and want to be able to turn each format off.

## Decision

### One model, several parsers

Every format parses into the same `AgentPlugin`, which gains a `format` tag and two optional component lists:

- `commands`: Markdown prompt templates, from Claude `commands/` and Cursor `commands/`.
- `rules`: Cursor `.mdc` rules.

Skills and MCP servers keep their existing shapes. The OpenCode mapping layer (`opencode.ts`) stays a pure function of the model, so it doesn't need to know which format a plugin came from.

### Detection and precedence

A directory can hold more than one manifest. cloudflare/skills ships all four. The plugin root is loaded once, using the first enabled format that has a manifest, in this order:

1. `agent-plugins`: root `plugin.json`. This is the portable standard, and OpenAI and Cursor both say it takes precedence.
2. `claude`: `.claude-plugin/plugin.json`
3. `codex`: `.codex-plugin/plugin.json`
4. `cursor`: `.cursor-plugin/plugin.json`

Turning a format off with `formats: { claude: false }` lets the next format claim the directory. A directory with no manifest from any enabled format isn't a plugin. The one exception is Claude Code, which treats a directory containing `skills/` or `.mcp.json` as a manifest-less plugin named after the directory. That only applies under a search path marked as Claude (see below), because otherwise any repo with a `skills/` folder would look like a plugin.

### Marketplaces

Claude and Cursor both use `marketplace.json` to list plugins in subdirectories. Local `source` paths (a string, or `{ source: "local", path }`) are followed. Git, URL and npm sources are skipped and reported, because installing plugins is the host's job, not the loader's.

The vendors' own install caches are added as search paths when their format is on:

- Claude: `~/.claude/plugins/marketplaces/*/` (each is a marketplace).
- Codex: `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. Only the newest version directory of each plugin is used.
- Cursor: `~/.cursor/plugins/local/*`.

These are off by default (`vendorDirs: false`), because loading every plugin a user installed into another tool is a big surprise. Users opt in.

### Vendor MCP mapping

Vendor `.mcp.json` entries infer their transport: `command` means stdio, and `url` with `type: http`, `streamable-http` or no type means Streamable HTTP. `sse` and `ws` are skipped. Unknown keys such as Codex's `env_vars` and `enabled`, or Claude's `oauth_resource`, are ignored with a warning. Ignoring them loses nothing that would change correctness.

Placeholder expansion follows each vendor's rules:

| Format | Root                                       | Data                                | Other `${VAR}`                                           |
| ------ | ------------------------------------------ | ----------------------------------- | -------------------------------------------------------- |
| Claude | `CLAUDE_PLUGIN_ROOT`                       | `CLAUDE_PLUGIN_DATA`                | Process env, with `${VAR:-default}`                      |
| Codex  | `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`        | `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA` | Left literal                                             |
| Cursor | `CURSOR_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` | none                                | Left literal (Cursor variables are set in the dashboard) |

Claude expands in `command`, `args`, `env`, `url` and `headers`. That's why the Claude GitHub plugin's `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` works. The value comes from the OpenCode server's environment and is only expanded for Claude-format plugins, which matches what Claude Code does. Stdio servers also get the matching root and data variables in their environment.

Containment still applies. A `./` command or `cwd` must resolve inside the plugin root, and a manifest component path must start with `./` and stay inside the root. Absolute paths in vendor MCP files are allowed, because Codex's bundled plugins use them.

### Commands and rules

- Commands become OpenCode commands named `<plugin>:<command>`. They're registered through the command transform, and their template expands `$ARGUMENTS` and `$1..$9` the way OpenCode's own Markdown commands do.
- Cursor rules with `alwaysApply: true` are added to the system prompt through the `context` hook. Rules that aren't always-applied become skills, since Cursor treats them as "the agent decides". `globs` scoping isn't supported, so glob-only rules become skills and the glob list is noted in the description.

### Components not mapped

Hooks, agents, LSP servers, output styles, apps and `userConfig` are reported as unsupported for each plugin, so users can see what they're missing. They aren't errors.

### Options

```jsonc
{
  "formats": { "agent-plugins": true, "claude": true, "codex": true, "cursor": true },
  "vendorDirs": false,
  "components": { "skills": true, "mcp": true, "commands": true, "rules": true },
}
```

## Consequences

- Plugin names must stay unique across formats. The first one found wins, as before.
- The Agent Plugins loader keeps its strict conformance. Vendor parsers are lenient, because their hosts are, and they report problems instead of rejecting the plugin.
- `/agent-plugins` shows the format next to each plugin.
