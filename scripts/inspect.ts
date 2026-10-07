#!/usr/bin/env bun
// Loads Agent Plugins from the given paths and prints what OpenCode would receive.
import path from "node:path";

import { loadAll } from "@/loader.ts";
import { formatStatus, toServerConfigs, toSkillInfo } from "@/opencode.ts";

const main = async () => {
  const searchPaths = process.argv.slice(2);
  const result = await loadAll(searchPaths, {
    dataRoot: path.join(process.cwd(), ".agent-plugins-data"),
  });
  console.log(formatStatus(result, searchPaths));
  for (const plugin of result.plugins) {
    const skills = toSkillInfo(plugin).map((skill) => ({
      bytes: skill.content.length,
      id: skill.id,
      path: skill.path,
    }));
    console.log(JSON.stringify({ mcp: toServerConfigs(plugin), skills }, undefined, 2));
  }
  return result.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
};

process.exitCode = await main();
