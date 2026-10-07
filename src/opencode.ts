import { Agent, Model, Provider, Skill } from "@opencode/plugin";
import type { Mcp } from "@opencode/plugin";

import type {
  AgentPlugin,
  Component,
  Diagnostic,
  LoadResult,
  PluginCommand,
  PluginAgent,
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
      skill.autoinvoke,
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

const toServerConfig = (server: PluginServer, policiesRegistered = false): Mcp.ServerConfig => {
  const options = {
    ...(server.disabled === undefined ? {} : { disabled: server.disabled }),
    ...(server.toolPolicy !== undefined && !policiesRegistered ? { disabled: true } : {}),
    ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
  };
  return server.type === "stdio"
    ? {
        ...options,
        command: [server.command, ...server.args],
        cwd: server.cwd,
        environment: server.env,
        type: "local",
      }
    : {
        ...options,
        headers: server.headers,
        type: "remote",
        url: server.url,
        ...(server.oauth === undefined ? {} : { oauth: server.oauth }),
      };
};

const serverConfigs = (
  plugin: AgentPlugin,
  policiesRegistered: boolean,
): [string, Mcp.ServerConfig][] =>
  Object.entries(plugin.servers).map(([name, server]) => [
    serverName(plugin, name),
    toServerConfig(server, policiesRegistered),
  ]);

const toServerConfigs = (plugin: AgentPlugin) => serverConfigs(plugin, false);
const toPolicyServerConfigs = (plugin: AgentPlugin) => serverConfigs(plugin, true);

const toCommands = (plugin: AgentPlugin): { name: string; command: PluginCommand }[] =>
  plugin.commands.map((command) => ({ command, name: commandName(plugin, command.name) }));

// Drops disabled component types so registration and the status report agree.
const scopeComponents = (plugin: AgentPlugin, components: ReadonlySet<Component>): AgentPlugin => ({
  ...plugin,
  agents: components.has("agents") ? plugin.agents : [],
  hooks: components.has("hooks") ? (plugin.hooks ?? []) : [],
  lsp: components.has("lsp") ? (plugin.lsp ?? {}) : {},
  styles: components.has("styles") ? (plugin.styles ?? []) : [],
  ...(plugin.runtimes === undefined
    ? {}
    : {
        runtimes: {
          ...plugin.runtimes,
          monitors: components.has("monitors") ? plugin.runtimes.monitors : [],
        },
      }),
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
  const agents = plugin.agents.map((agent) => `${plugin.manifest.name}:${agent.name}`);
  const empty =
    skills.length + servers.length + commands.length + rules.length + agents.length === 0;
  return [
    `${plugin.manifest.name}${version} [${plugin.format}] (${plugin.root})`,
    ...list("skills", skills),
    ...list("mcp", servers),
    ...list("commands", commands),
    ...list("always-on rules", rules),
    ...list("agents", agents),
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

const toAgentInfo = (plugin: AgentPlugin): Agent.Info[] =>
  plugin.agents.map((agent: PluginAgent) => {
    const id = Agent.ID.make(`${plugin.manifest.name}:${agent.name}`);
    const defaults = Agent.Info.default(id);
    const [provider, modelWithVariant] = agent.model?.split("/") ?? [];
    const [model, variant] = modelWithVariant?.split("#") ?? [];
    return {
      ...defaults,
      mode: agent.mode,
      name: Agent.Info.fields.name.make(agent.name),
      permissions:
        agent.permissions.length === 0
          ? defaults.permissions
          : [
              ...agent.permissions,
              ...defaults.permissions.filter(
                (rule) =>
                  rule.action === "external_directory" ||
                  (rule.action === "read" &&
                    agent.permissions.some(
                      (permission) => permission.action === "read" && permission.effect === "allow",
                    )),
              ),
            ],
      system: agent.system,
      ...(agent.description === undefined ? {} : { description: agent.description }),
      ...(agent.color === undefined ? {} : { color: agent.color }),
      ...(agent.steps === undefined ? {} : { steps: agent.steps }),
      ...(provider === undefined || model === undefined
        ? {}
        : {
            model: {
              id: Model.ID.make(model),
              providerID: Provider.ID.make(provider),
              ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
            },
          }),
    };
  });

export {
  toAgentInfo,
  alwaysRules,
  scopeComponents,
  commandName,
  formatStatus,
  serverName,
  skillID,
  toCommands,
  toServerConfigs,
  toPolicyServerConfigs,
  toSkillInfo,
};
