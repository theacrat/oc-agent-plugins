import { Skill } from "@opencode/plugin";
import type { Mcp } from "@opencode/plugin";

import type {
  AgentPlugin,
  Component,
  Diagnostic,
  LoadResult,
  PluginCommand,
  PluginRule,
  PluginServer,
} from "#src/types.ts";

const { fields } = Skill.Info;

const skillID = (plugin: AgentPlugin, skill: string) => `${plugin.manifest.name}:${skill}`;
const serverName = (plugin: AgentPlugin, server: string) => `${plugin.manifest.name}-${server}`;
const commandName = (plugin: AgentPlugin, command: string) => `${plugin.manifest.name}:${command}`;
const ruleSkillName = (rule: PluginRule) => `rule-${rule.name}`;

const makeSkill = (
  id: string,
  name: string,
  description: string,
  file: string,
  content: string,
  autoinvoke?: boolean,
) =>
  Skill.Info.make({
    content,
    description,
    id: fields.id.make(id),
    name: fields.name.make(name),
    path: fields.path.make(file),
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
  });

// Rules that aren't always-applied are "the agent decides" in Cursor, which is what a skill is.
const ruleDescription = (rule: PluginRule) => {
  const base = rule.description ?? `Rule ${rule.name}`;
  return rule.globs.length === 0 ? base : `${base} (applies to ${rule.globs.join(", ")})`;
};

const toSkillInfo = (plugin: AgentPlugin): Skill.Info[] => [
  ...plugin.skills.map((skill) =>
    makeSkill(
      skillID(plugin, skill.name),
      skill.name,
      skill.description,
      skill.path,
      skill.content,
    ),
  ),
  ...plugin.rules
    .filter((rule) => !rule.alwaysApply)
    .map((rule) =>
      makeSkill(
        skillID(plugin, ruleSkillName(rule)),
        ruleSkillName(rule),
        ruleDescription(rule),
        rule.path,
        rule.content,
      ),
    ),
];

const alwaysRules = (plugin: AgentPlugin): string[] =>
  plugin.rules
    .filter((rule) => rule.alwaysApply)
    .map(
      (rule) =>
        `<rule plugin="${plugin.manifest.name}" name="${rule.name}">\n${rule.content}\n</rule>`,
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

const toCommands = (plugin: AgentPlugin): { name: string; command: PluginCommand }[] =>
  plugin.commands.map((command) => ({ command, name: commandName(plugin, command.name) }));

// Drops disabled component types so registration and the status report agree.
const scopeComponents = (plugin: AgentPlugin, components: ReadonlySet<Component>): AgentPlugin => ({
  ...plugin,
  commands: components.has("commands") ? plugin.commands : [],
  rules: components.has("rules") ? plugin.rules : [],
  servers: components.has("mcp") ? plugin.servers : {},
  skills: components.has("skills") ? plugin.skills : [],
});

const formatDiagnostic = (diagnostic: Diagnostic) =>
  `- ${diagnostic.severity}: ${diagnostic.source}: ${diagnostic.message}`;

const list = (label: string, items: readonly string[]) =>
  items.length === 0 ? [] : [`  ${label}: ${items.join(", ")}`];

const formatPlugin = (plugin: AgentPlugin) => {
  const version = plugin.manifest.version === undefined ? "" : `@${plugin.manifest.version}`;
  const skills = toSkillInfo(plugin).map((skill) => skill.id);
  const servers = Object.keys(plugin.servers).map((name) => serverName(plugin, name));
  const commands = plugin.commands.map((command) => `/${commandName(plugin, command.name)}`);
  const rules = plugin.rules.filter((rule) => rule.alwaysApply).map((rule) => rule.name);
  const empty = skills.length + servers.length + commands.length + rules.length === 0;
  return [
    `${plugin.manifest.name}${version} [${plugin.format}] (${plugin.root})`,
    ...list("skills", skills),
    ...list("mcp", servers),
    ...list("commands", commands),
    ...list("always-on rules", rules),
    ...(empty ? ["  nothing OpenCode can use"] : []),
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

export {
  alwaysRules,
  scopeComponents,
  commandName,
  formatStatus,
  serverName,
  skillID,
  toCommands,
  toServerConfigs,
  toSkillInfo,
};
