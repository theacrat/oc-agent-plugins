import path from "node:path";

import { listDir, readText, resolveWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";
import { componentPaths } from "#src/vendor/paths.ts";

interface RuntimeFile {
  readonly path: string;
  readonly text: string;
}

const readRuntimeFile = async (
  root: string,
  candidate: string,
  directory: string,
  report: Report,
): Promise<RuntimeFile | undefined> => {
  const contained = await resolveWithin(root, candidate);
  if (contained.kind !== "file") {
    report({
      message: `${directory} file is ${contained.kind}`,
      severity: "error",
      source: candidate,
    });
    return undefined;
  }
  const read = await readText(contained.path);
  if (!read.ok) {
    report({ message: read.error, severity: "error", source: candidate });
    return undefined;
  }
  return { path: contained.path, text: read.text };
};

const loadRuntimeFiles = async (
  root: string,
  declared: unknown,
  directory: string,
  extension: string,
  report: Report,
): Promise<RuntimeFile[]> => {
  const targets =
    declared === undefined
      ? [path.join(root, directory)]
      : componentPaths(declared, root, directory, report);
  const groups = await Promise.all(
    targets.map(async (target) => {
      const resolved = await resolveWithin(root, target);
      if (resolved.kind === "missing" && declared === undefined) {
        return [];
      }
      if (resolved.kind !== "file" && resolved.kind !== "directory") {
        report({
          message: `${directory} path is ${resolved.kind}`,
          severity: "error",
          source: target,
        });
        return [];
      }
      const entries = resolved.kind === "directory" ? await listDir(resolved.path) : [];
      return resolved.kind === "file"
        ? [resolved.path]
        : entries.map((entry) => path.join(resolved.path, entry.name));
    }),
  );
  const files = await Promise.all(
    [...new Set(groups.flat())]
      .filter((candidate) => candidate.endsWith(extension))
      .toSorted()
      .map(async (candidate) => readRuntimeFile(root, candidate, directory, report)),
  );
  return [
    ...new Map(
      files.filter((file) => file !== undefined).map((file) => [file.path, file]),
    ).values(),
  ];
};

export type { RuntimeFile };
export { loadRuntimeFiles };
