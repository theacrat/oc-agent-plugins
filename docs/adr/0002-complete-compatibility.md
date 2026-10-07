# ADR 0002: Close the compatibility audit

## Contract

Every audited feature must have one of three explicit outcomes: translated and tested, handled through an opt-in bridge/export, or rejected with a precise reason and safe remediation. A successful load must not silently discard authentication, enablement or permission restrictions. Vendor trust settings are not implied by finding installed files.

## Delivery units

1. Preserve MCP enablement, OAuth, timeouts and tool policy. Reject unsupported security-sensitive fields rather than widen permissions. Add safe bundle parsing and declared-transport support only where it can be enforced.
2. Translate vendor hooks through OpenCode hooks with explicit event contracts, opt-in execution and lifecycle cleanup. Reject hook types/events whose semantics cannot be preserved.
3. Add declared configuration values, environment-based secret references, model aliases, output styles and glob rule activation. Keep secrets out of model-visible bodies.
4. Provide explicit handling for LSP export, app-ID resolution, channels, workflows, monitors and themes. Do not mutate global config, fetch private service credentials or execute arbitrary runtime modules at startup.
5. Verify integration, disabled components, reload/unload, malformed inputs and the real plugin corpus. Update the audit with actual implementation status.

## Throughput checkpoint

Independent implementation lanes own separate worktrees and non-overlapping modules. The parent owns final integration and native runtime smoke tests. Each lane supplies a commit, tests and a list of any genuine external/API blockers. A blocker is not represented as support.
