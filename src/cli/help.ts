const HELP = `oc-agent-plugins

Usage: npx oc-agent-plugins <command> [options]

Commands:
  install <source>     Install a local folder or Git repository snapshot
  update <name>       Refresh an unchanged managed installation
  update --all        Refresh all managed installations
  list                List installed packages, including disabled packages
  info <name>         Show ownership, source and installed revision
  enable <name>       Restore a disabled managed package
  disable <name>      Remove a managed package from discovery without deleting it
  uninstall <name>    Remove an unchanged managed package; runtime data is retained
  doctor              Check receipts and installed content for problems

Options:
  --global, -g        Use the global OpenCode vendor directory
  --project, -p PATH  Use PATH/.opencode/agent-plugins (default: current directory)
  --ref REF           Git branch, tag or commit for installation
  --subdir PATH       Plugin root within a repository
  --json              Machine-readable output
  --help, -h          Show help
  --version, -v       Show this CLI's version

Requirements:
  Linux, macOS or Windows with Node >=22.14.0.
  Git is required only for remote repository sources.

Examples:
  npx oc-agent-plugins install cloudflare/skills
  npx oc-agent-plugins install ./my-plugin --global
  npx oc-agent-plugins install https://github.com/acme/plugins.git --ref main --subdir plugins/review

The OpenCode adapter must be loaded separately. Installs never execute plugin code,
connect MCP servers or grant hook/monitor trust. Edited and unmanaged folders are protected.
`;

export { HELP };
