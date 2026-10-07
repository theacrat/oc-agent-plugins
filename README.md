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
        "discovery": { "paths": ["~/src/my-plugins"], "vendorDirs": true },
        "formats": { "cursor": false },
        "rules": { "enabled": false },
      },
    },
  ],
}
```

If you don't need options, symlinking the directory into `~/.config/opencode/plugins/` or `.opencode/plugins/` also works.

## Settings layout

Settings inside the OpenCode plugin entry's `options` have two groups of responsibility:

- **Feature settings** configure discovery, storage, formats and individual component types.
- **`plugins.<name>`** keeps every setting for one imported plugin in one place. Use its manifest name, not its folder name.

Only set what you need. Defaults still load skills, agents, commands and MCP servers; hooks and monitors require explicit per-plugin trust.

| Group                                                          | Settings                                                                                                   | Default                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `discovery`                                                    | `paths`, `vendorDirs`                                                                                      | No extra paths; vendor folders off                 |
| `storage`                                                      | `dataDir`                                                                                                  | `$XDG_DATA_HOME/opencode/agent-plugins`            |
| `formats`                                                      | `agent-plugins`, `claude`, `codex`, `cursor` booleans                                                      | All on                                             |
| `skills`, `agents`, `mcp`, `rules`, `hooks`, `monitors`, `lsp` | `enabled`                                                                                                  | All on; trust still required for execution         |
| `commands`                                                     | `enabled`, `shellInjection`                                                                                | Both on                                            |
| `styles`                                                       | `enabled`, `selected` (`plugin:name`), `allowSystemReplacement`                                            | Enabled; no selected style; system replacement off |
| `plugins.<name>`                                               | `enabled`, `hooks.trusted`, `monitors.trusted`, `configuration`, `agents.modelAliases`, `mcp.appEndpoints` | Normal activation; no trust or supplied values     |

Unknown fields are reported with their full path. Malformed nested settings reject the configuration rather than silently changing trust. Old flat options still work with a migration warning, but cannot be mixed with the grouped layout in the same `options` object.

## Where plugins are found

The search paths are `~/.agents/plugins`, `<project>/.agents/plugins`, everything in `discovery.paths`, and the vendor directories when `discovery.vendorDirs` is on.

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
  - `${VAR}` and `${VAR:-default}` read the OpenCode server's environment in MCP config only. They're never expanded in Markdown bodies. This matches Claude Code, and it's how the GitHub plugin's `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` header works. It also means a Claude plugin can send any variable from the OpenCode server's environment to its own MCP host, so only load Claude plugins you'd trust with that. To opt out, turn off `claude` in `formats`, or set `mcp.enabled` to false.
  - Commands follow Claude's argument rules: `$ARGUMENTS`, 0-based `$N` and `$ARGUMENTS[N]`, named `arguments`, and the trailing `ARGUMENTS:` fallback. They also run `` !`cmd` `` injection in the session directory. Injections only come from the command file itself. Anything in the text you type after the command is never run.
  - A Claude plugin with no manifest still loads when a marketplace lists it. Codex and Cursor plugins need their manifest.
  - `disable-model-invocation` hides a skill from the model, but you can still load it by ID.
- **Codex**: reads `.codex-plugin/plugin.json`, `skills/` plus any declared `skills`, `.mcp.json` and declared `mcpServers`. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, along with their `CLAUDE_` aliases. Enablement, OAuth, timeouts and tool availability/approval policies are preserved. Settings native V2 cannot preserve reject that server instead of weakening its policy.
- **Cursor**: reads `.cursor-plugin/plugin.json`, `skills/`, `rules/`, `commands/` and `mcp.json`. A declared path replaces the default location. A root `SKILL.md` counts as a single-skill plugin. `${CURSOR_PLUGIN_ROOT}` is expanded. Commands use OpenCode's own argument rules.

See [the compatibility audit](docs/compatibility-audit.md) for native support, opt-in bridges and actual API blockers. Unsupported security-sensitive server settings reject the server; they are never silently ignored.

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

Claude and Cursor `agents/` files (or declared `agents` paths) become OpenCode subagents named `<plugin>:<agent>`. Their prompts, descriptions, colours, step limits and tool restrictions are mapped. Restricted tools are never widened to unrestricted grants. Claude model aliases such as `sonnet` and `opus` inherit the session model and produce a warning; explicit `provider/model` values are retained. Set `agents: { enabled: false }` to disable agent registration.

`discovery.vendorDirs` only controls where this loader searches. For example, with it off, a Claude plugin in `~/.claude/plugins/marketplaces` is not searched automatically, but it still loads if you include that directory in `discovery.paths`. It never starts Claude, Codex or Cursor.

## Per-plugin settings

This is an example `options` object. It belongs inside the OpenCode plugin entry, not in the imported plugin's manifest. The two plugins are configured independently, and each feature's options sit together.

```jsonc
{
  "discovery": {
    "paths": ["~/src/my-plugins"],
    "vendorDirs": false,
  },
  "commands": { "shellInjection": false },
  "styles": { "selected": "my-plugin:concise" },
  "plugins": {
    "my-plugin": {
      "enabled": true,
      "hooks": { "trusted": true },
      "monitors": { "trusted": false },
      "configuration": {
        "userConfig": {
          "tenant": "public",
          "api_token": { "env": "PLUGIN_API_TOKEN" },
        },
      },
      "agents": {
        "modelAliases": { "sonnet": "anthropic/claude-sonnet-4-5" },
      },
      "mcp": {
        "appEndpoints": {
          "asdk_app_example": { "url": "https://example.com/mcp" },
        },
      },
    },
    "unwanted-plugin": { "enabled": false },
  },
}
```

For a Cursor plugin, put `variables` and optionally `publicVariables` inside that plugin's `configuration` group. Sensitive values use environment references, never literal credentials. App endpoint mappings are scoped to their owning plugin, even when two plugins use the same app ID.

- **Configuration:** Claude `userConfig` and Cursor variable declarations are validated, including required fields/defaults. Sensitive values must use environment references. Cursor variables default to sensitive; only names in `publicVariables` may enter model bodies. Secrets are rejected in prompt bodies, rules, descriptions and runtime exports.
- **Hooks:** supported command/exec tool hooks translate vendor inputs, matchers and outputs. Explicit `plugins.<name>.hooks.trusted` opt-in is required. Events or decisions without an equivalent contract are reported precisely; failed pre-tool translation blocks execution. This is a tested subset, not complete vendor hook parity.
- **Styles:** `/agent-plugins-style plugin:name` selects a style for that session; `clear` removes the selection. Forced plugin styles take precedence. Styles that discard coding instructions require explicit `styles.allowSystemReplacement: true`, because V2 cannot isolate that part of the assembled system prompt.
- **Rules:** matching file-tool calls activate Cursor glob-scoped rules for subsequent requests in that session. Arbitrary shell file access is not tracked.
- **Monitors:** `/agent-plugins-monitors start` explicitly starts trusted monitors; `stop` terminates them. Process ownership, output limits, aborts, session deletion and reload/unload cleanup are enforced. POSIX only; Windows process-group termination is not implemented.
- **LSP:** `/agent-plugins-lsp` produces a validated project-config fragment. It never writes configuration. Unsupported LSP operational fields are rejected rather than lost.
- **Apps:** `.app.json` IDs resolve only through explicit `appEndpoints` mappings. Those endpoints receive normal MCP validation/policies. No OpenAI app endpoint or credential is inferred.
- **Export-only runtimes:** `/agent-plugins-export` shows workflows, themes and channel declarations with bridge requirements. Workflow scripts are never evaluated in the server. There is no safe Claude-isolated workflow runtime, native vendor theme importer or Claude channel notification/routing API in this adapter.

`enabled: false` and `disabled: true` MCP servers stay disabled. Exact tool allowlists and denylists filter the catalog and are rechecked at execution; `prompt` approval requests permission without overriding configured denies. OAuth `false` and validated native-compatible settings are retained. Timeout seconds are converted to native milliseconds. An environment whitelist (`env_vars`), dynamic header helper, unsupported OAuth resource/policy, SSE/WebSocket transport or bundle archive rejects that entry with remediation. It is not substituted with a less restrictive connection.

### Migrating flat settings

Move `paths`/`vendorDirs` to `discovery`, `dataDir` to `storage`, and `shellInjection` to `commands`. Replace `components: { rules: false }` with `rules: { enabled: false }`. Move `outputStyle`/`allowSystemReplacement` to `styles.selected`/`styles.allowSystemReplacement`.

For each plugin, collect its old `pluginSettings`, `trustedHooks`, `trustedMonitors`, `configuration` and `appEndpoints` entries under `plugins.<name>`. Put model aliases in that plugin's `agents.modelAliases` and endpoint mappings in its `mcp.appEndpoints`. Do not combine old and new keys in one options object.
