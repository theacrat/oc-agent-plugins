# ADR 0004: Node-runnable plugin manager

## Goal

`npx oc-agent-plugins` manages installed portable/vendor plugin packages without requiring Bun, starting OpenCode, executing plugin code, granting hook trust or modifying unrelated OpenCode configuration.

## Domain and ownership

An `Installation` has an immutable manifest identity, format/version, typed `Source` (local folder or Git repository/ref/subdirectory), resolved Git commit when applicable, content fingerprint and active/disabled location. A manager owns only installations with a validated versioned receipt. Existing unmanaged folders are never overwritten or deleted.

Default scope is the current project's `.opencode/agent-plugins`; `--global` selects `configDirectory(home, env)/agent-plugins`. `--project <path>` selects a project explicitly. Native OpenCode `plugins/` is never managed.

Installed packages are copied snapshots, not live symlinks or mutable Git worktrees. Local update recopies the recorded source; Git update resolves the recorded ref. A pinned commit remains pinned. `--subdir` selects a contained plugin root within a repository. GitHub `owner/repo` shorthand and HTTPS/SSH Git URLs are accepted. Archive downloads, npm lifecycle execution and submodules are outside this initial source contract.

## Lifecycle

Installation validates the manifest only, so missing credentials or unavailable MCP services do not prevent package management. No subprocess from a plugin is launched. Package files must remain inside the resolved source root. `.git` and `node_modules` are excluded. Links are either safely materialised from inside the root or rejected; special files and escaping links are rejected.

The original Linux-only payload-read restriction is superseded by [ADR 0006](0006-cross-platform-management.md). Management uses portable containment and identity checks, with additional descriptor-path verification where available. Untrusted concurrent directory mutation is outside the supported filesystem contract.

Mutations acquire a target-directory lock, stage on the same filesystem, validate and fingerprint before an atomic rename, and roll back replacements on errors. Receipts are committed with the package. Updates preserve plugin identity and reject local edits rather than discarding user work. Interrupted operation metadata must be detected and handled safely. Disable/enable moves managed snapshots into/out of a sibling hidden storage directory; uninstall removes only a verified managed snapshot and retains persistent runtime data.

Normal validation failures clean up the newly owned staging directory and leave the prior installation unchanged. Incomplete stages remain private manager scratch space and are removed on ordinary acquisition or validation errors. Cleanup preserves replaced stage directories and detects edits to validated, fingerprinted stages before deleting them. Journals and backups from interrupted mutations remain available for manual recovery.

Commands are `install`, `update <name>|--all`, `list`, `info`, `enable`, `disable`, `uninstall` (alias `remove`), `doctor`, `help` and `version`. `--json` gives machine-readable output. Missing packages, invalid arguments, conflicts and unsafe paths fail with nonzero exit codes and actionable messages. Enabling an installation does not grant hooks/monitor trust.

OpenCode exposes the same operations through `/agent-plugins-manage`. Its native command executor calls the shared manager directly, using the invoking session's location as the default project and relative-source base. Quoted arguments are tokenised without shell execution or interpolation. Results and errors are synthetic messages with model continuation disabled. Mutations do not implicitly reload vendor runtime components; `/agent-plugins` remains the explicit rescan command.

Temporary directories use the operating system's temporary-directory resolver and unique owned directories rather than hard-coded global `/tmp` paths. Git isolation uses the platform's null device. Portable scratch paths do not relax the secure payload-read platform requirement.

## Packaging and verification

TypeScript stays the source language; Bun builds a standalone Node ESM CLI with a `node` shebang into `dist/cli.js`. npm's `bin` maps `oc-agent-plugins` to it. The native OpenCode entrypoint remains raw TypeScript. CI/release build and pack the CLI, verify production-only plugin import and run the packed CLI using Node/npx. No global credentials or version publication are required to test it.

## Throughput checkpoint

Separate worktrees own source acquisition and transactional installation storage. The parent owns argv/output, settings/path wiring, docs, packaging and end-to-end packed npx tests. Independent standards/spec reviews gate merge. Persistent files outside owned installation paths are not deleted or rewritten.
