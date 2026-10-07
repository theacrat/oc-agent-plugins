# Compatibility status

Checked against OpenCode V2 documentation, the published OpenAPI contract and `@opencode/plugin` 2.0.24. Implemented behaviour is covered by tests; native smoke-test findings are distinguished below. This adapter does not claim full vendor-runtime parity.

## Implemented and integrated

| Feature                                      | Behaviour                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills, commands, agents                     | Namespaced native registration, vendor argument syntax, plugin-path expansion, conservative agent tool restrictions and explicit model aliases.                                                                                                                                                 |
| MCP enablement                               | `enabled: false` and `disabled: true` preserve the native disabled state. Contradictory/malformed values reject the entry.                                                                                                                                                                      |
| MCP OAuth                                    | `false` and validated native-compatible OAuth settings are preserved. Unknown OAuth semantics reject the entry.                                                                                                                                                                                 |
| MCP timeouts                                 | Validated seconds-to-milliseconds conversion and native startup/catalog/execution timeout objects. Ambiguous scalar timeout values reject the entry.                                                                                                                                            |
| MCP tool policies                            | Exact allowlists/denylists, catalog filtering, execution guards and permission escalation for `prompt`. Configured denies remain final. Policy-bearing servers stay disabled unless enforcement is registered.                                                                                  |
| Claude user configuration / Cursor variables | Declaration/type/constraint/default/required validation. Sensitive values require explicit environment references. Public values only enter bodies; secret values and references are rejected in rules, descriptions, prompts and model-visible exports.                                        |
| Output styles                                | Explicit per-session selection and forced-style precedence. Keeping styles append instructions. Non-keeping styles require explicit whole-system replacement because V2 cannot separate coding instructions.                                                                                    |
| Cursor glob rules                            | Native file-tool activity activates rules for subsequent model requests, scoped by session. Arbitrary shell file access is not tracked.                                                                                                                                                         |
| Vendor hooks                                 | Opt-in command/exec tool hooks and compaction observation with translated vendor names/input, timeout/cancellation, bounded output and redaction. Unsupported pre-tool outputs fail closed. Unsupported lifecycle/blocking/async contracts are diagnosed, not approximated as faithful support. |
| Monitors                                     | Explicit trusted startup, always/on-skill-invoke conditions, bounded process/output/runtime budgets, notifications and process-group cleanup on stop, deletion, reload and unload. Windows execution fails explicitly.                                                                          |
| Plugin activation                            | Adapter `pluginSettings` opt-out/opt-in, manifest `defaultEnabled: false`, marketplace `NOT_AVAILABLE` deny. Other applications' enabled/trust settings are not inferred from installed files.                                                                                                  |

## Explicit bridges and exports

| Feature       | Handling and reason                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LSP           | Validated native project-config export through `/agent-plugins-lsp`. The current plugin context has no LSP transform. No global/project settings are changed. Operational fields native config cannot preserve reject that server. |
| Codex app IDs | `.app.json` parses into MCP servers only when `appEndpoints` explicitly resolves each ID. IDs alone are references to OpenAI infrastructure, not URLs. No private credentials are fetched.                                         |
| Workflows     | Metadata/source discovery and export, never evaluation. Claude's no-filesystem/no-module-loading isolated orchestration contract is not provided by a Node subprocess or `node:vm`. A separate isolated runtime is required.       |
| Themes        | Conservative validation and export with exact CLI mapping requirements. Server-side loading does not imply a native vendor-theme importer.                                                                                         |
| Channels      | Validated declarations and precise explanation of missing Claude MCP notification/capability and authenticated session-routing contracts. No invented listener or endpoint.                                                        |

## Server entries rejected rather than weakened

- SSE/WebSocket MCP transports. Native remote configuration selects Streamable HTTP and has no transport selector; model-provider WebSocket hooks are unrelated.
- `.mcpb` / `.dxt` bundles. Safe archive extraction and bundle-specific configuration are not implemented.
- `env_vars`. Native stdio inherits a process environment and cannot enforce the vendor's whitelist. Use an explicitly environment-isolated stdio launcher.
- Dynamic `headersHelper`. Native remote transforms expose no per-request header-generation callback. Use a separately reviewed external bridge.
- Unrepresentable OAuth resource parameters, tool-policy values, discovery/approval semantics and malformed settings. Rejected overrides remove earlier entries of the same name rather than retaining a less restrictive definition.

These are actual remaining blockers, not hidden successful loads. Completing them needs a reviewed transport/runtime bridge or upstream API support. They are not called implemented.

## Verification

The native smoke fixture confirmed an enabled policy-bearing stdio server connected, a disabled remote server remained disabled, and the MCP tool issued a real permission request. A model request produced the selected output-style response; a shell call ran a trusted hook; a monitor delivered output; the LSP command emitted the correct native config fragment. Disabling these components removed the servers on config reload. The test server was stopped afterwards.

Independent review reproductions led to regression tests for secret-bearing rules/descriptions, complete setup rollback and disposal, and malformed supplied configuration. Package verification includes the root entrypoint and a production-only extracted-package import.

The installed corpus now reports previously hidden incompatible fields as errors. A lower diagnostic count is not a goal if it means discarding security policy.

## Sources

- [OpenCode plugin API](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode MCP configuration](https://opencode.ai/v2/docs/mcp-servers/)
- [OpenCode configuration](https://opencode.ai/v2/docs/config/)
- [OpenCode CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli/)
- [OpenCode tools and permissions](https://opencode.ai/v2/docs/tools/)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude output styles](https://code.claude.com/docs/en/output-styles)
- [Claude dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Cursor plugin reference](https://cursor.com/docs/reference/plugins)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
