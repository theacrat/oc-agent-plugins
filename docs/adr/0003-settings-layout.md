# ADR 0003: Group settings by feature and plugin

Public options are organised around two ownership axes.

- Global feature settings live in named groups. `discovery` owns paths and vendor-directory discovery, `storage` owns data location, and `components` owns all feature switches. Simple features are booleans; `components.commands` and `components.styles` are objects for enablement and additional behaviour (`shellInjection`, `selected`, `allowSystemReplacement`). `formats` still names the accepted package formats.
- Per-plugin settings live together under `plugins.<manifest-name>`. Activation, hook/monitor trust, declared configuration, agent model aliases and MCP app endpoint mappings no longer appear in separate maps or lists.

The parser normalises these groups into the internal runtime shape. There is no legacy-layout handling or migration path because this project has not been released. Unknown fields are reported at their full option path; malformed values reject configuration.

`plugins.<name>.components` overrides global component settings field by field. Unspecified fields inherit global values; explicit enablement can override either direction. Registration operates on the scoped plugin contents rather than global guards, so per-plugin opt-in still works when a feature is globally off. Hook and monitor trust remains a separate opt-in. Selected output styles are session-wide; multiple plugin-specific default selections reject rather than using arbitrary precedence.
