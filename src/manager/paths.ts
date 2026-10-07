import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import nodePath from "node:path";

import type { Installation } from "./types.ts";

const { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } = nodePath;

type StageIdentity = Pick<Stats, "dev" | "ino" | "birthtimeMs">;
type StageOwner =
  | { readonly kind: "handle"; readonly handle: FileHandle; readonly identity: StageIdentity }
  | { readonly kind: "identity"; readonly identity: StageIdentity };

function sameStageIdentity(current: StageIdentity, original: StageIdentity): boolean {
  return (
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.birthtimeMs === original.birthtimeMs
  );
}

async function openStage(stage: string, identity: StageIdentity): Promise<StageOwner> {
  try {
    return { handle: await open(stage, "r"), identity, kind: "handle" };
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EPERM", "EISDIR", "EACCES"].includes(String(error.code)) ||
      !("syscall" in error) ||
      error.syscall !== "open" ||
      !("path" in error) ||
      error.path !== stage
    ) {
      throw error;
    }
    return { identity, kind: "identity" };
  }
}

function validateName(name: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name) ||
    name === "node_modules" ||
    name.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  ) {
    throw new Error(`Unsafe plugin name: ${name}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function safeDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) {
    await safeDirectory(parent, create);
  }
  if (!(await exists(absolute)) && create) {
    await mkdir(absolute);
  }
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe directory (symlinks are not allowed): ${absolute}`);
  }
}

async function checkStage(stage: string, owner: StageOwner): Promise<void> {
  await safeDirectory(dirname(stage));
  const current = await lstat(stage);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameStageIdentity(current, owner.identity) ||
    (owner.kind === "handle" && !sameStageIdentity(await owner.handle.stat(), owner.identity))
  ) {
    throw new Error(`Staging directory replaced; retained for inspection: ${stage}`);
  }
}

function storePaths(root: string) {
  const active = resolve(root);
  if (basename(active) !== "agent-plugins") {
    throw new Error("Store root must be agent-plugins");
  }
  return {
    active,
    disabled: join(dirname(active), ".agent-plugins-disabled"),
    state: join(dirname(active), ".agent-plugins-manager"),
  };
}

async function validateTree(directory: string): Promise<void> {
  await safeDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await validateTree(path);
      } else if (!entry.isFile()) {
        throw new Error(`Unsafe payload entry: ${path}`);
      }
    }),
  );
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return (
    difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))
  );
}

async function validateSource(source: string, targets: readonly string[]): Promise<void> {
  const canonical = await realpath(source);
  if (canonical === parse(canonical).root) {
    throw new Error("Filesystem root cannot be a plugin source");
  }
  for (const target of targets) {
    const absolute = resolve(target);
    if (contains(absolute, canonical) || contains(canonical, absolute)) {
      throw new Error("Source and store directories must not overlap");
    }
  }
}

async function stateProblems(state: string): Promise<string[]> {
  if (!(await exists(state))) {
    return [];
  }
  await safeDirectory(state);
  const problems: string[] = [];
  if (await exists(join(state, "journal.json"))) {
    problems.push("Interrupted transaction: journal.json requires manual recovery");
  }
  if (await exists(join(state, "lock"))) {
    problems.push("Store lock exists; inspect its owner before recovery");
  }
  for (const entry of await readdir(state)) {
    if (entry.startsWith("stage-") || entry.startsWith("remove-")) {
      problems.push(`Retained transaction snapshot: ${entry}`);
    }
  }
  return problems;
}

async function stateInventory(state: string): Promise<Installation[]> {
  const problems = await stateProblems(state);
  return problems.length === 0
    ? []
    : [
        {
          directory: state,
          enabled: false,
          managed: false,
          name: ".agent-plugins-manager",
          problem: problems.join("\n"),
        },
      ];
}

export {
  checkStage,
  exists,
  openStage,
  safeDirectory,
  stateInventory,
  stateProblems,
  storePaths,
  validateName,
  validateSource,
  validateTree,
};
export type { StageOwner };
