#!/usr/bin/env bun
// Loads plugins from the given paths and prints what OpenCode would receive.
// Flags: --json for machine-readable output, --vendor-dirs to include vendor install caches,
// --no-<format> to turn a format off (for example --no-claude).
import { homedir } from "node:os";
import path from "node:path";

import { loadAll } from "#src/loader.ts";
import {
  alwaysRules,
  formatStatus,
  toCommands,
  toServerConfigs,
  toSkillInfo,
} from "#src/opencode.ts";
import { parseOptions } from "#src/options.ts";
import { FORMATS } from "#src/types.ts";
import type { Diagnostic } from "#src/types.ts";

const main = async () => {
  const argv = process.argv.slice(2);
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const formats = Object.fromEntries(
    FORMATS.filter((format) => argv.includes(`--no-${format}`)).map((format) => [format, false]),
  );
  const diagnostics: Diagnostic[] = [];
  const options = parseOptions(
    {
      dataHome: path.join(process.cwd(), ".agent-plugins-data"),
      home: homedir(),
      project: process.cwd(),
      raw: { discovery: { paths, vendorDirs: argv.includes("--vendor-dirs") }, formats },
    },
    (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  );
  const result = await loadAll(options.searchPaths, {
    dataRoot: options.dataRoot,
    env: process.env,
    formats: options.formats,
    ...(options.codexCache === undefined ? {} : { codexCache: options.codexCache }),
  });
  const all = { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
  if (argv.includes("--json")) {
    const plugins = all.plugins.map((plugin) => ({
      agents: plugin.agents.map((agent) => `${plugin.manifest.name}:${agent.name}`),
      alwaysRules: alwaysRules(plugin).length,
      commands: toCommands(plugin).map(({ name }) => name),
      format: plugin.format,
      mcp: toServerConfigs(plugin),
      name: plugin.manifest.name,
      root: plugin.root,
      skills: toSkillInfo(plugin).map((skill) => skill.id),
    }));
    console.log(JSON.stringify({ diagnostics: all.diagnostics, plugins }, undefined, 2));
  } else {
    console.log(formatStatus(all, options.searchPaths));
  }
  return all.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
};

process.exitCode = await main();
