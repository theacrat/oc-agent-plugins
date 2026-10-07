# opencode-agent-plugins

An OpenCode v2 plugin that loads [Agent Plugins](https://agent-plugins.org/) 1.0.0 packages, plus Claude Code, Codex and Cursor plugins. Their skills, MCP servers, commands, rules and agents show up in OpenCode as if you'd configured them by hand. Each format and each component type can be turned off.

## Install

Point `plugins` in `opencode.json(c)` at this directory. It has to be the directory, not `index.ts`, because OpenCode only accepts a directory as a local plugin path.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-agent-plugins",
      "options": {
        "paths": ["~/src/my-plugins"],
        "formats": { "cursor": false },
        "components": { "rules": false },
        "vendorDirs": true,
      },
    },
  ],
}
```

If you don't need options, symlinking the directory into `~/.config/opencode/plugins/` or `.opencode/plugins/` also works.

## Options

| Option           | Default                                 | Effect                                                                                                                                         |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`          | `[]`                                    | Extra search paths. Relative paths resolve against the project, and `~` is your home directory.                                                |
| `formats`        | all `true`                              | `{ "agent-plugins", "claude", "codex", "cursor" }`. Set one to `false` to stop loading that format.                                            |
| `components`     | all `true`                              | `{ "skills", "mcp", "commands", "rules", "agents" }`. Set one to `false` to stop registering that component type.                              |
| `vendorDirs`     | `false`                                 | Also load plugins already installed for other tools: `~/.claude/plugins/marketplaces`, `~/.codex/plugins/cache` and `~/.cursor/plugins/local`. |
| `shellInjection` | `true`                                  | Run `` !`cmd` `` blocks in Claude commands when you invoke the command. With this off, they show up as text instead.                           |
| `dataDir`        | `$XDG_DATA_HOME/opencode/agent-plugins` | Where each plugin's persistent data directory lives.                                                                                           |

Unknown or mistyped options are reported. They don't stop the plugin loading.

## Where plugins are found

The search paths are `~/.agents/plugins`, `<project>/.agents/plugins`, everything in `paths`, and the vendor directories when `vendorDirs` is on.

Each search path can be any of these:

- A plugin root.
- A marketplace (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json` or `.agents/plugins/marketplace.json`). Only local `source` entries are followed. Git, URL and npm entries are counted and reported, because installing them is the host tool's job.
- A directory whose immediate children are plugin roots or marketplaces.

A directory containing more than one manifest loads once, using the first enabled format in this order: `agent-plugins` (root `plugin.json`), `claude`, `codex`, `cursor`. Turning a format off lets the next one claim the directory. If two plugins share a name, the first one found wins and the other is reported.

## What you get

| Source                                 | OpenCode                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Skills from every format               | Skill `<plugin>:<skill>`                                                  |
| MCP servers from every format          | MCP server `<plugin>-<server>`. Stdio becomes local, HTTP becomes remote. |
| Claude `commands/`, Cursor `commands/` | Command `/<plugin>:<command>`                                             |
| Cursor rules with `alwaysApply: true`  | Added to the system prompt on every agent request                         |
| Other Cursor rules                     | Skill `<plugin>:rule-<name>`, with any globs listed in the description    |

The plugin also adds `/agent-plugins`. It rescans everything, reloads it, and posts a report into the session showing each plugin's format, what loaded, and every diagnostic. It doesn't start a model turn.

### Format details

- **Agent Plugins** follow the spec strictly. See [Conformance](#agent-plugins-conformance).
- **Claude Code**: reads `.claude-plugin/plugin.json` (optional when a marketplace lists the plugin), `skills/` plus any declared `skills`, and `commands/` or declared `commands`, including the inline object form. `.mcp.json` and declared `mcpServers` are merged, with later names winning.
  - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are expanded in MCP config and in skill and command bodies. `${CLAUDE_SKILL_DIR}` is expanded in skill bodies.
  - `${VAR}` and `${VAR:-default}` read the OpenCode server's environment in MCP config only. They're never expanded in Markdown bodies. This matches Claude Code, and it's how the GitHub plugin's `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` header works. It also means a Claude plugin can send any variable from the OpenCode server's environment to its own MCP host, so only load Claude plugins you'd trust with that. To opt out, turn off `claude` in `formats`, or turn off `mcp` in `components`.
  - Commands follow Claude's argument rules: `$ARGUMENTS`, 0-based `$N` and `$ARGUMENTS[N]`, named `arguments`, and the trailing `ARGUMENTS:` fallback. They also run `` !`cmd` `` injection in the session directory. Injections only come from the command file itself. Anything in the text you type after the command is never run.
  - A Claude plugin with no manifest still loads when a marketplace lists it. Codex and Cursor plugins need their manifest.
  - `disable-model-invocation` hides a skill from the model, but you can still load it by ID.
- **Codex**: reads `.codex-plugin/plugin.json`, `skills/` plus any declared `skills`, `.mcp.json` and declared `mcpServers`. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, along with their `CLAUDE_` aliases. Host-only keys like `env_vars` and `enabled` are ignored with a warning.
- **Cursor**: reads `.cursor-plugin/plugin.json`, `skills/`, `rules/`, `commands/` and `mcp.json`. A declared path replaces the default location. A root `SKILL.md` counts as a single-skill plugin. `${CURSOR_PLUGIN_ROOT}` is expanded. Commands use OpenCode's own argument rules.

Hooks, LSP servers, apps, output styles, `userConfig` and Cursor `variables` have no OpenCode equivalent. Each plugin that uses them gets a warning listing what was ignored. SSE, WebSocket and MCP bundle (`.mcpb`) servers are skipped with a warning.

## Diagnostics

Every problem is logged to the OpenCode server log with an `[agent-plugins]` prefix, and also shows up in the `/agent-plugins` report. Problems are isolated: a bad skill, server or command skips only itself, and a bad manifest skips only that plugin.

## Agent Plugins conformance

- `plugin.json` is validated against the closed schema. Unknown fields and a non-object `extensions` are reported and ignored. Every other violation rejects the plugin.
- Only the 1.0.0 `$schema` identifiers are accepted, and schemas are never fetched.
- Every package path is checked after resolving symlinks on both sides. Escapes are handled at the narrowest boundary: the whole plugin, one component type, one skill, or one server.
- Skills come only from the immediate children of `skills/`, and they're validated against the Agent Skills spec.
- `mcp.json` must match the plugin's spec version. A bad document disables MCP for that plugin only, and a bad entry skips only that server.
- `command` is a single token, either a bare name or `./`-relative. `cwd` must be `./`, `${PLUGIN_ROOT}` or `${PLUGIN_DATA}` rooted and stay inside its root.
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, with no rescanning, in `args`, `env` values and `cwd` only.
- `env` can't set `PLUGIN_ROOT` or `PLUGIN_DATA`, and on Windows that check is case-insensitive.
- Remote URLs must be absolute http(s) with no user info or fragment, and https unless the host is loopback. Header names must be valid and unique regardless of case.

## Develop

```sh
bun install
bun run check                         # oxlint, oxfmt --check, vitest
bun run inspect <path>...             # what OpenCode would get; exits 1 on any error
bun run inspect --vendor-dirs --json  # everything installed for Claude, Codex and Cursor
bun run inspect --no-claude <path>    # turn a format off
```

Source files import each other through the `#src/*` subpath import in `package.json`. That's because OpenCode runs `src/` as raw TypeScript, where tsconfig `paths` don't apply. A lint rule enforces it.

[cloudflare/skills](https://github.com/cloudflare/skills) ships all four manifests and is the real-world fixture. CI clones it at a pinned commit, and locally `CLOUDFLARE_SKILLS=/path/to/checkout bun run test` runs the same check. `examples/hello` is a minimal Agent Plugin with a dependency-free stdio MCP server.

### Agents

Claude and Cursor `agents/` files (or declared `agents` paths) become OpenCode subagents named `<plugin>:<agent>`. Their prompts, descriptions, colours, step limits and tool restrictions are mapped. Restricted tools are never widened to unrestricted grants. Claude model aliases such as `sonnet` and `opus` inherit the session model and produce a warning; explicit `provider/model` values are retained. Set `components: { agents: false }` to disable agent registration.

`vendorDirs` only controls where this loader searches. For example, with it off, a Claude plugin in `~/.claude/plugins/marketplaces` is not searched automatically, but it still loads if you include that directory in `paths`. It never starts Claude, Codex or Cursor.
