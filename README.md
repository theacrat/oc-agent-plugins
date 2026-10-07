# opencode-agent-plugins

An OpenCode v2 plugin that loads [Agent Plugins](https://agent-plugins.org/) 1.0.0 packages. Each plugin's skills and MCP servers show up in OpenCode as if you'd configured them by hand.

## Install

From a checkout, symlink or copy this directory into a plugin discovery directory:

```sh
ln -s /path/to/opencode-agent-plugins ~/.config/opencode/plugins/agent-plugins
```

Or reference it from `opencode.json(c)`, passing options if you need them:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-agent-plugins",
      "options": {
        "paths": ["~/src/my-agent-plugins"],
        "dataDir": "~/.local/share/agent-plugins-data",
      },
    },
  ],
}
```

## Where plugins are found

Every search path is either an Agent Plugin root (it has `plugin.json`) or a directory whose immediate children are plugin roots.

1. `~/.agents/plugins/`
2. `<project>/.agents/plugins/`
3. Each entry in the `paths` option. Relative paths resolve against the project directory, and `~` expands to your home directory.

If two plugins share a `name`, the first one found wins and the other is reported.

## What you get in OpenCode

| Agent Plugin                 | OpenCode                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| `skills/<skill>/SKILL.md`    | Skill with ID `<plugin>:<skill>`                                            |
| `mcp.json` `stdio` server    | Local MCP server named `<plugin>-<server>`                                  |
| `mcp.json` `streamable-http` | Remote MCP server named `<plugin>-<server>`, with OAuth handled by OpenCode |
| `mcp.json` `sse`             | Skipped and reported, since the spec makes support optional                 |
| `extensions`, extension dirs | Ignored, because this plugin defines no namespace of its own                |

Stdio servers get `PLUGIN_ROOT` (the resolved plugin root) and `PLUGIN_DATA` (`$XDG_DATA_HOME/opencode/agent-plugins/<plugin>` by default, or `<dataDir>/<plugin>`). The data directory is created before launch and is never deleted.

## Diagnostics

Invalid plugins, skills and servers are logged to the OpenCode server log with an `[agent-plugins]` prefix. Run `/agent-plugins` in a session to rescan every search path, reload skills and MCP servers, and add a status report to the session without starting a model turn.

## Conformance

The loader follows each MUST in the 1.0.0 specification:

- `plugin.json` is validated against the closed schema. Unknown fields and a non-object `extensions` are reported and ignored. Every other violation rejects the plugin.
- Only the 1.0.0 `$schema` identifiers are accepted, and schemas are never fetched.
- Every package path is checked after resolving symlinks. Escapes are handled at the narrowest boundary: the whole plugin, one component type, one skill, or one server.
- Skills come only from immediate children of `skills/`, and they're validated against the Agent Skills spec. That covers name rules, the name matching its directory, description length, and the optional field types.
- `mcp.json` must match the plugin's spec version. A bad document disables MCP for that plugin only, and a bad entry skips only that server.
- `command` is a single token, either a bare name or `./`-relative. `cwd` must be `./`, `${PLUGIN_ROOT}` or `${PLUGIN_DATA}` rooted and must stay inside its root.
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, with no rescanning, in `args`, `env` values and `cwd` only.
- `env` can't set `PLUGIN_ROOT` or `PLUGIN_DATA`, and on Windows that check is case-insensitive.
- Remote URLs must be absolute http(s) with no user info or fragment, and https unless the host is loopback. Header names must be valid and unique regardless of case.

Some transport behaviour belongs to OpenCode's MCP client: process spawning, Streamable HTTP, OAuth, and how configured headers are handled across redirects.

## Develop

```sh
bun install
bun run check   # oxlint, oxfmt --check, vitest
```

Run `bun run inspect <path>...` to see what OpenCode would get from a plugin, including diagnostics. It exits with code 1 if anything was invalid.

[cloudflare/skills](https://github.com/cloudflare/skills) is the real-world fixture. CI clones it at a pinned commit, and locally `CLOUDFLARE_SKILLS=/path/to/checkout bun run test` runs the same check.

`examples/hello` is a working Agent Plugin. It has one skill and a dependency-free stdio MCP server that reports its own `PLUGIN_ROOT`, `PLUGIN_DATA`, expanded `env` and `cwd`.
