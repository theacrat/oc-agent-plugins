# ADR 0003: Group settings by feature and plugin

Public options are organised around two ownership axes.

- Global feature settings live in named groups. `discovery` owns paths and vendor-directory discovery, `storage` owns data location, and each component owns its enablement and behaviour (`commands.shellInjection`, `styles.selected`, `styles.allowSystemReplacement`). `formats` still names the accepted package formats.
- Per-plugin settings live together under `plugins.<manifest-name>`. Activation, hook/monitor trust, declared configuration, agent model aliases and MCP app endpoint mappings no longer appear in separate maps or lists.

The parser normalises these groups into the existing internal runtime shape. Runtime behaviour is unchanged. Existing flat options remain readable with a migration warning. Mixing old and new layouts is rejected rather than ambiguously combining trust or precedence. Invalid nested groups and values reject the configuration, including malformed trust booleans. Unknown fields are reported at their full option path.

The README and tests use the grouped layout. Legacy parsing is an explicit migration boundary, not another recommended interface.
