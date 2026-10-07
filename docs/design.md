# Design

## Context

Agent Plugins 1.0.0 defines a portable directory format with two component types: Agent Skills and MCP servers. OpenCode v2 already has native skill and MCP registries that plugins can edit through transforms. This plugin is a client adapter. It parses the portable format at the boundary, then hands OpenCode's own registries the native shapes.

## Decisions

**Parse once into a typed model, then map.** `loader.ts` turns a directory into `AgentPlugin` (manifest, skills, servers) plus a list of `Diagnostic`s. Every spec rule lives in that parse step. `opencode.ts` is a pure mapping from `AgentPlugin` to `Skill.Info` and `Mcp.ServerConfig`, so the OpenCode-specific part stays small and the spec logic can be tested without OpenCode running.

**Placeholders are resolved in the parse step.** OpenCode's local MCP config takes a literal argv, `cwd` and `environment`. The loader expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, resolves `./` commands to absolute paths, and adds the reserved variables last. OpenCode never sees an unexpanded placeholder.

**Namespacing.** Skills become `<plugin>:<skill>` and servers become `<plugin>-<server>`. That stops two plugins with a skill or server of the same name from overwriting each other, and keeps the origin visible in the UI. Plugin names are unique within a load, and the first one found wins.

**Search paths.** `~/.agents/plugins` and `<project>/.agents/plugins` follow the vendor-neutral `.agents/` convention the spec uses in its own examples. The `paths` option covers anything else. Installation and updates are client policy implemented separately by the CLI in [ADR 0004](adr/0004-plugin-manager-cli.md); marketplaces remain out of scope.

**SSE is skipped.** The spec makes legacy HTTP+SSE optional, and OpenCode's remote config doesn't let a client pin the initial transport to SSE. Skipping and reporting is conformant. Mapping SSE to `remote` isn't, because the initial attempt would use the wrong transport.

**Diagnostics go to the log and to `/agent-plugins`.** There's no persistent UI surface for plugin warnings. The rescan command reloads both registries and posts a synthetic report with `resume: false`, so checking status doesn't cost a model call.

**Reload is manual.** Transforms replay captured state, and the plugin doesn't watch the filesystem. `/agent-plugins` rescans. A watcher would add a lifecycle and debouncing for what's usually a one-off install.

## Not handled

- Client extension namespaces. Nothing OpenCode-specific is needed yet, so `extensions` and extension directories are ignored, which is what the spec requires for unimplemented namespaces.
- Agent Skills `allowed-tools` (experimental). The value is validated but not applied to OpenCode permissions.
