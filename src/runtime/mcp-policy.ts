import type { Plugin } from "@opencode/plugin";

import { serverName } from "#src/opencode.ts";
import type { AgentPlugin, PluginServer } from "#src/types.ts";

interface Context {
  readonly tool: Pick<Plugin.Context["tool"], "hook" | "transform">;
  readonly permission: Pick<Plugin.Context["permission"], "hook">;
}
interface PolicyEntry {
  readonly name: string;
  readonly server: PluginServer;
}
const normalise = (name: string) => name.replaceAll(/[^A-Za-z0-9_-]/gu, "_");

const mcpPolicies = (plugins: readonly AgentPlugin[]): readonly PolicyEntry[] => {
  const entries = plugins.flatMap((plugin) =>
    Object.entries(plugin.servers).map(([name, server]) => ({
      name: normalise(serverName(plugin, name)),
      server,
    })),
  );
  for (const entry of entries) {
    if (
      entries.some(
        (other) =>
          other !== entry &&
          (other.name === entry.name ||
            other.name.startsWith(`${entry.name}_`) ||
            entry.name.startsWith(`${other.name}_`)),
      )
    ) {
      throw new Error(
        `MCP server namespace collision involving "${entry.name}"; rename servers to unambiguous native namespaces before registration`,
      );
    }
  }
  return entries;
};

const mcpToolEffect = (entries: readonly PolicyEntry[], id: string): "deny" | "ask" | undefined => {
  const entry = entries.find(({ name }) => id.startsWith(`${name}_`));
  if (entry === undefined) {
    return undefined;
  }
  const name = id.slice(entry.name.length + 1);
  const { server } = entry;
  const policy = server.toolPolicy;
  if (
    server.disabled === true ||
    (policy?.enabled !== undefined && !policy.enabled.includes(name)) ||
    policy?.disabled?.includes(name)
  ) {
    return "deny";
  }
  return policy?.tools?.[name]?.approval ?? policy?.approval;
};

const restrictMcpPermission = (
  entries: readonly PolicyEntry[],
  event: { readonly action: string; effect: "allow" | "ask" | "deny" },
) => {
  const effect = mcpToolEffect(entries, event.action);
  if (effect === "deny" || (effect === "ask" && event.effect !== "deny")) {
    event.effect = effect;
  }
};

const filterMcpTools = (
  entries: readonly PolicyEntry[],
  editor: Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0],
) => {
  for (const tool of editor.list()) {
    const effect = mcpToolEffect(entries, tool.id);
    if (effect === "deny") {
      editor.remove(tool.id);
    }
    if (effect === "ask") {
      editor.update(tool.id, (draft) => {
        draft.options = { ...draft.options, permission: tool.id };
      });
    }
  }
};

// Register before enabling policy-bearing servers. The supplier is reread for execution and reload.
const registerMcpPolicies = async (ctx: Context, plugins: () => readonly AgentPlugin[]) => {
  const known = new Map(mcpPolicies(plugins()).map((entry) => [entry.name, entry]));
  const current = () => {
    const active = mcpPolicies(plugins());
    for (const entry of active) {
      known.set(entry.name, entry);
    }
    const entries: PolicyEntry[] = [];
    for (const entry of known.values()) {
      if (active.some(({ name }) => name === entry.name)) {
        entries.push(entry);
      } else {
        entries.push({ name: entry.name, server: { ...entry.server, disabled: true } });
      }
    }
    return entries;
  };
  const registrations: { dispose: () => Promise<void> }[] = [];
  try {
    registrations.push(
      await ctx.permission.hook("evaluate", (event) => {
        restrictMcpPermission(current(), event);
      }),
    );
    const guard = await ctx.tool.hook("execute.before", (event) => {
      if (mcpToolEffect(current(), event.tool) === "deny") {
        throw new Error(`MCP tool "${event.tool}" is blocked by the plugin's availability policy`);
      }
    });
    registrations.push(guard);
    const filter = await ctx.tool.transform((editor) => {
      filterMcpTools(current(), editor);
    });
    registrations.push(filter);
  } catch (error) {
    await Promise.all(registrations.map(async (registration) => registration.dispose()));
    throw error;
  }
  return {
    async dispose() {
      await Promise.all(registrations.map(async (registration) => registration.dispose()));
    },
  };
};

export { filterMcpTools, mcpPolicies, mcpToolEffect, registerMcpPolicies, restrictMcpPermission };
