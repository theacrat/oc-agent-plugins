import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "#src/json.ts";

type Resolved =
  | { readonly kind: "missing" }
  | { readonly kind: "outside" }
  | { readonly kind: "file" | "directory" | "other"; readonly path: string };

type ReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const isWithin = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const realOrSelf = async (target: string) => {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
};

// Follows symlinks on both sides, then checks the real target is still inside the real root.
// Anything unreadable (missing, permission denied, removed mid-scan) counts as missing.
const resolveWithin = async (root: string, target: string): Promise<Resolved> => {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return { kind: "missing" };
  }
  if (!isWithin(await realOrSelf(root), real)) {
    return { kind: "outside" };
  }
  try {
    const info = await stat(real);
    if (info.isFile()) {
      return { kind: "file", path: real };
    }
    return { kind: info.isDirectory() ? "directory" : "other", path: real };
  } catch {
    return { kind: "missing" };
  }
};

// File reads never throw, so one unreadable file skips only the component it belongs to.
const readText = async (file: string): Promise<ReadResult> => {
  try {
    return { ok: true, text: await readFile(file, "utf8") };
  } catch (error) {
    return { error: `can't read file: ${errorMessage(error)}`, ok: false };
  }
};

// Directory listing that treats an unreadable directory as empty.
const listDir = async (directory: string): Promise<Dirent[]> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Recursive listing for component directories; unreadable subtrees are skipped.
const listTree = async (directory: string): Promise<Dirent[]> => {
  try {
    return await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
};

// Creates a plugin data directory; returns an error message instead of throwing.
const ensureDir = async (directory: string): Promise<string | undefined> => {
  try {
    await mkdir(directory, { recursive: true });
    return undefined;
  } catch (error) {
    return `can't create ${directory}: ${errorMessage(error)}`;
  }
};

export type { ReadResult, Resolved };
export { ensureDir, isWithin, listDir, listTree, readText, realOrSelf, resolveWithin };
