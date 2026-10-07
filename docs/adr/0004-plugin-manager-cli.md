# ADR 0004: Node-runnable plugin manager

## Goal

`npx oc-agent-plugins` manages installed portable/vendor plugin packages without requiring Bun, starting OpenCode, executing plugin code, granting hook trust or modifying unrelated OpenCode configuration.

## Domain and ownership

An `Installation` has an immutable manifest identity, format/version, typed `Source` (local folder or Git repository/ref/subdirectory), resolved Git commit when applicable, content fingerprint and active/disabled location. A manager owns only installations with a validated versioned receipt. Existing unmanaged folders are never overwritten or deleted.

Default scope is the current project's `.opencode/agent-plugins`; `--global` selects `configDirectory(home, env)/agent-plugins`. `--project <path>` selects a project explicitly. Native OpenCode `plugins/` is never managed.

Installed packages are copied snapshots, not live symlinks or mutable Git worktrees. Local update recopies the recorded source; Git update resolves the recorded ref. A pinned commit remains pinned. `--subdir` selects a contained plugin root within a repository. GitHub `owner/repo` shorthand and HTTPS/SSH Git URLs are accepted. Archive downloads, npm lifecycle execution and submodules are outside this initial source contract.

## Lifecycle

Installation validates the manifest only, so missing credentials or unavailable MCP services do not prevent package management. No subprocess from a plugin is launched. Package files must remain inside the resolved source root. `.git` and `node_modules` are excluded. Links are either safely materialised from inside the root or rejected; special files and escaping links are rejected.

Secure payload reads require Linux descriptor-path verification through `/proc/self/fd`. Other platforms fail closed instead of using canonical-path/inode checks that cannot guarantee containment against adversarial parent-directory swaps. Help and version remain available on those platforms. Cross-platform secure payload reads require a future descriptor-relative filesystem bridge.

Mutations acquire a target-directory lock, stage on the same filesystem, validate and fingerprint before an atomic rename, and roll back replacements on errors. Receipts are committed with the package. Updates preserve plugin identity and reject local edits rather than discarding user work. Interrupted operation metadata must be detected and handled safely. Disable/enable moves managed snapshots into/out of a sibling hidden storage directory; uninstall removes only a verified managed snapshot and retains persistent runtime data.

Normal validation failures clean up the newly owned staging directory and leave the prior installation unchanged. Cleanup must not delete a replaced or externally modified stage. Journals and backups from interrupted mutations remain available for manual recovery.

Commands are `install`, `update <name>|--all`, `list`, `info`, `enable`, `disable`, `uninstall` (alias `remove`), `doctor`, `help` and `version`. `--json` gives machine-readable output. Missing packages, invalid arguments, conflicts and unsafe paths fail with nonzero exit codes and actionable messages. Enabling an installation does not grant hooks/monitor trust.

## Packaging and verification

TypeScript stays the source language; Bun builds a standalone Node ESM CLI with a `node` shebang into `dist/cli.js`. npm's `bin` maps `oc-agent-plugins` to it. The native OpenCode entrypoint remains raw TypeScript. CI/release build and pack the CLI, verify production-only plugin import and run the packed CLI using Node/npx. No global credentials or version publication are required to test it.

## Throughput checkpoint

Separate worktrees own source acquisition and transactional installation storage. The parent owns argv/output, settings/path wiring, docs, packaging and end-to-end packed npx tests. Independent standards/spec reviews gate merge. Persistent files outside owned installation paths are not deleted or rewritten.
