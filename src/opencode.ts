import { Skill } from "@opencode/plugin";
import type { Mcp } from "@opencode/plugin";

import type { AgentPlugin, Diagnostic, LoadResult, PluginServer } from "@/types.ts";

const { fields } = Skill.Info;

const skillID = (plugin: AgentPlugin, skill: string) => `${plugin.manifest.name}:${skill}`;
const serverName = (plugin: AgentPlugin, server: string) => `${plugin.manifest.name}-${server}`;

const toSkillInfo = (plugin: AgentPlugin): Skill.Info[] =>
  plugin.skills.map((skill) =>
    Skill.Info.make({
      content: skill.content,
      description: skill.description,
      id: fields.id.make(skillID(plugin, skill.name)),
      name: fields.name.make(skill.name),
      path: fields.path.make(skill.path),
    }),
  );

const toServerConfig = (server: PluginServer): Mcp.ServerConfig =>
  server.type === "stdio"
    ? {
        command: [server.command, ...server.args],
        cwd: server.cwd,
        environment: server.env,
        type: "local",
      }
    : { headers: server.headers, type: "remote", url: server.url };

const toServerConfigs = (plugin: AgentPlugin): [string, Mcp.ServerConfig][] =>
  Object.entries(plugin.servers).map(([name, server]) => [
    serverName(plugin, name),
    toServerConfig(server),
  ]);

const formatDiagnostic = (diagnostic: Diagnostic) =>
  `- ${diagnostic.severity}: ${diagnostic.source}: ${diagnostic.message}`;

const formatPlugin = (plugin: AgentPlugin) => {
  const version = plugin.manifest.version === undefined ? "" : `@${plugin.manifest.version}`;
  const skills = plugin.skills.map((skill) => skillID(plugin, skill.name));
  const servers = Object.keys(plugin.servers).map((name) => serverName(plugin, name));
  return [
    `${plugin.manifest.name}${version} (${plugin.root})`,
    `  skills: ${skills.join(", ") || "none"}`,
    `  mcp: ${servers.join(", ") || "none"}`,
  ];
};

const formatStatus = (result: LoadResult, searchPaths: readonly string[]) =>
  [
    `Agent Plugins searched: ${searchPaths.join(", ")}`,
    "",
    ...(result.plugins.length === 0
      ? ["No plugins loaded."]
      : result.plugins.flatMap(formatPlugin)),
    ...(result.diagnostics.length === 0
      ? []
      : ["", "Diagnostics:", ...result.diagnostics.map(formatDiagnostic)]),
  ].join("\n");

export { formatStatus, serverName, skillID, toServerConfigs, toSkillInfo };
