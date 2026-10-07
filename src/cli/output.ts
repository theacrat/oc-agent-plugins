import type { Installation } from "#src/manager/types.ts";

const installationLine = (entry: Installation): string =>
  [
    entry.name,
    entry.enabled ? "enabled" : "disabled",
    entry.managed ? "managed" : "unmanaged",
    entry.receipt?.version ?? entry.metadata?.manifest.version ?? "unversioned",
    ...(entry.problem === undefined ? [] : [`problem: ${entry.problem}`]),
  ].join("  ");

const listOutput = (entries: readonly Installation[], root: string): string =>
  [
    root,
    ...(entries.length === 0
      ? ["No plugins installed."]
      : entries.map((entry) => installationLine(entry))),
  ].join("\n");

const infoOutput = (entry: Installation): string => {
  const { receipt } = entry;
  const source = receipt?.source;
  let sourceText = "not managed by this CLI";
  if (source?.kind === "local") {
    sourceText = source.path;
  }
  if (source?.kind === "git") {
    sourceText = `${source.url}${source.ref === undefined ? "" : `#${source.ref}`}${source.subdir === undefined ? "" : ` (${source.subdir})`}`;
  }
  return [
    installationLine(entry),
    `Directory: ${entry.directory}`,
    `Source: ${sourceText}`,
    ...(receipt?.revision === undefined ? [] : [`Revision: ${receipt.revision}`]),
  ].join("\n");
};

export { infoOutput, listOutput };
