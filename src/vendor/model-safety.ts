import type { AgentPlugin } from "#src/types.ts";

// Every string that may be shown to the model, including metadata and export-only definitions,
// passes through the resolved configuration's secret guard before registration.
const assertModelSafety = (plugin: AgentPlugin): void => {
  const check = plugin.configuration?.assertContent;
  if (check === undefined) {
    return;
  }
  const strings = [
    plugin.manifest.name,
    plugin.manifest.description ?? "",
    ...plugin.skills.flatMap((entry) => [entry.name, entry.description, entry.content]),
    ...plugin.commands.flatMap((entry) => [entry.name, entry.description ?? "", entry.template]),
    ...plugin.agents.flatMap((entry) => [entry.name, entry.description ?? "", entry.system]),
    ...plugin.rules.flatMap((entry) => [
      entry.name,
      entry.description ?? "",
      entry.content,
      ...entry.globs,
    ]),
    ...(plugin.styles ?? []).flatMap((entry) => [
      entry.name,
      entry.description ?? "",
      entry.content,
    ]),
    ...(plugin.runtimes?.workflows ?? []).flatMap((entry) => [
      entry.name,
      entry.description,
      entry.source,
    ]),
    ...(plugin.runtimes?.themes ?? []).map((entry) => JSON.stringify(entry)),
    ...(plugin.runtimes?.channels ?? []).flatMap((entry) => [entry.server, entry.displayName]),
    ...(plugin.runtimes?.monitors ?? []).flatMap((entry) => [
      entry.name,
      entry.description,
      entry.command,
      entry.when,
    ]),
    JSON.stringify(plugin.lsp ?? {}),
  ];
  for (const value of strings) {
    check(value);
  }
};

export { assertModelSafety };
