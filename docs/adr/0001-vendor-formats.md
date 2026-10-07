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

Turning a format off with `formats: { claude: false }` lets the next format claim the directory. A directory with no manifest from any enabled format isn't a plugin. The one exception is Claude Code, which loads a plugin with no manifest when a Claude marketplace lists it, and names it after the marketplace entry or its directory. Plugins are never detected from a `skills/` folder alone, because then any repo with a `skills/` folder would look like a plugin. Codex and Cursor marketplace entries still need their own manifest.

### Marketplaces

Claude and Cursor both use `marketplace.json` to list plugins in subdirectories. Local `source` paths (a string, or `{ source: "local", path }`) are followed. Git, URL and npm sources are skipped and reported, because installing plugins is the host's job, not the loader's.

The vendors' own install caches are added as search paths when their format is on:

- Claude: `~/.claude/plugins/marketplaces/*/` (each is a marketplace).
- Codex: `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. Only the newest version directory of each plugin is used.
- Cursor: `~/.cursor/plugins/local/*`.

These are off by default (`vendorDirs: false`), because loading every plugin a user installed into another tool is a big surprise. Users opt in.

### Vendor MCP mapping

Vendor `.mcp.json` entries infer their transport: `command` means stdio, and `url` with `type: http`, `streamable-http` or no type means Streamable HTTP. `sse` and `ws` are skipped. Unknown keys such as Codex's `env_vars` and `enabled`, or Claude's `oauth_resource`, are ignored with a warning. Ignoring them loses nothing that would change correctness.

Every filesystem read goes through `paths.ts`. That keeps the escape check working after symlinks are resolved on both sides, including for marketplace `source` entries. It also turns an unreadable or vanished file into a diagnostic for that one component instead of an exception.

Placeholder expansion follows each vendor's rules:

| Format | Root                                       | Data                                | Other `${VAR}`                                           |
| ------ | ------------------------------------------ | ----------------------------------- | -------------------------------------------------------- |
| Claude | `CLAUDE_PLUGIN_ROOT`                       | `CLAUDE_PLUGIN_DATA`                | Process env, with `${VAR:-default}`                      |
| Codex  | `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`        | `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA` | Left literal                                             |
| Cursor | `CURSOR_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` | none                                | Left literal (Cursor variables are set in the dashboard) |

Claude expands in `command`, `args`, `env`, `url` and `headers`. That's why the Claude GitHub plugin's `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` works. The value comes from the OpenCode server's environment and is only expanded for Claude-format plugins, which matches what Claude Code does. Stdio servers also get the matching root and data variables in their environment.

Containment still applies. A `./` command or `cwd` must resolve inside the plugin root, and a manifest component path must start with `./` and stay inside the root. Absolute paths in vendor MCP files are allowed, because Codex's bundled plugins use them.

### Commands and rules

- Commands become OpenCode commands named `<plugin>:<command>`, registered through the command transform. Each format keeps its own argument rules, because templates are written against them:
  - Claude commands use Claude Code's rules. That means `$ARGUMENTS`, 0-based `$N` and `$ARGUMENTS[N]`, named `arguments` from frontmatter, an unfilled index left literal, and `ARGUMENTS: <input>` appended when nothing received an argument. Nested files are named `dir:file`.
  - Claude commands also get `` !`cmd` `` injection, run in the session directory. Injections are taken from the template before any arguments go in, so text the user passes can never become a command. 2 of the 33 installed Claude commands (`commit`, `commit-push-pr`) depend on it. Like OpenCode's own `!` blocks, it only runs when the user invokes the command. The `shellInjection` option turns it off, and the command is then shown as text.
  - Cursor commands use OpenCode's own Markdown rules: `$ARGUMENTS` and 1-based `$N`.
- Claude skill and command bodies get `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and (in skills) `${CLAUDE_SKILL_DIR}`. 216 references in the installed corpus depend on these. Environment variables are never expanded in bodies, because the model would see their values.
- Claude's `disable-model-invocation` becomes OpenCode's `autoinvoke: false`.
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

## Verification

Run against the 76 plugins installed for Claude Code and Codex on the author's machine plus cloudflare/skills (`bun run inspect --vendor-dirs`): 96 skills, 16 MCP servers, 32 commands, 0 errors. This was also checked in a running OpenCode server:

- A Cursor command and an always-apply rule both reached the model.
- `/commit-commands:commit` injected live git status.
- `/code-modernization:modernize-status billing` bound `$system` and resolved `${CLAUDE_PLUGIN_ROOT}`.
- Turning off `claude`, `codex` and `rules` in config removed them on reload.

## Consequences

- Plugin names must stay unique across formats. The first one found wins, as before.
- The Agent Plugins loader keeps its strict conformance. Vendor parsers are lenient, because their hosts are, and they report problems instead of rejecting the plugin.
- `/agent-plugins` shows the format next to each plugin.
