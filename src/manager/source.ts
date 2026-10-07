import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireGitSource } from "#src/manager/git.ts";
import { EXCLUDED, safeRelativePath } from "#src/manager/snapshot.ts";
import { RECEIPT } from "#src/manager/types.ts";
import type { AcquiredSource, Source } from "#src/manager/types.ts";

interface SourceOptions {
  readonly cwd: string;
  readonly ref?: string;
  readonly subdir?: string;
}

const validateRef = (ref: string): void => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new Error(`Unsafe Git ref: ${ref}`);
  }
};

const validateGitSource = (source: Extract<Source, { kind: "git" }>): void => {
  const { url, ref, subdir } = source;
  if (ref !== undefined) {
    validateRef(ref);
  }
  if (
    subdir !== undefined &&
    (!safeRelativePath(subdir) ||
      subdir.startsWith("/") ||
      subdir.split("/").some((part) => EXCLUDED.has(part) || part === RECEIPT))
  ) {
    throw new Error(`Subdirectory must be a contained relative path: ${subdir}`);
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(url)) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Unsupported Git URL: ${url}`);
  }
  if (
    !["https:", "ssh:", "file:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    /[\s\0\\]/u.test(url)
  ) {
    throw new Error(`Unsafe Git URL: ${url}`);
  }
  if (parsed.protocol === "file:" && parsed.hostname !== "" && parsed.hostname !== "localhost") {
    throw new Error("File Git URLs must refer to the local host");
  }
};

const parseSource = async (input: string, options: SourceOptions): Promise<Source> => {
  if (input.length === 0 || input.includes("\0")) {
    throw new Error("Source must not be empty or contain NUL");
  }
  const local = path.resolve(options.cwd, input);
  try {
    const directory = await realpath(local);
    const stat = await lstat(directory);
    if (!stat.isDirectory()) {
      throw new Error("Local source must be a directory");
    }
    if (options.ref !== undefined || options.subdir !== undefined) {
      throw new Error("--ref and --subdir require a Git source");
    }
    return { kind: "local", path: directory };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const separator = input.indexOf("#");
  const location = separator === -1 ? input : input.slice(0, separator);
  const fragment = separator === -1 ? undefined : input.slice(separator + 1);
  if (fragment !== undefined && options.ref !== undefined && fragment !== options.ref) {
    throw new Error("Source ref and --ref disagree");
  }
  const url = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(location)
    ? `https://github.com/${location}.git`
    : location;
  const ref = options.ref ?? fragment;
  const source: Source = {
    kind: "git",
    url,
    ...(ref === undefined ? {} : { ref }),
    ...(options.subdir === undefined ? {} : { subdir: options.subdir }),
  };
  validateGitSource(source);
  if (url.startsWith("file:")) {
    await realpath(fileURLToPath(url));
  }
  return source;
};

const acquireSource = async (source: Source, scratchParent: string): Promise<AcquiredSource> => {
  if (source.kind === "git") {
    validateGitSource(source);
    return acquireGitSource(source, scratchParent);
  }
  const directory = await realpath(source.path);
  const stat = await lstat(directory);
  if (!stat.isDirectory()) {
    throw new Error("Local source must be a directory");
  }
  return {
    directory,
    dispose: async () => {
      await Promise.resolve();
    },
    source: { kind: "local", path: directory },
  };
};

export type { SourceOptions };
export { acquireSource, parseSource };
