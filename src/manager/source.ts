import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { acquireGitSource } from "#src/manager/git.ts";
import { validateGitSource } from "#src/manager/source-policy.ts";
import type { AcquiredSource, Source } from "#src/manager/types.ts";

interface SourceOptions {
  readonly cwd: string;
  readonly ref?: string;
  readonly subdir?: string;
}

const looksRemote = (input: string): boolean =>
  /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(input) || input.startsWith("git@");

const parseSource = async (input: string, options: SourceOptions): Promise<Source> => {
  if (input.length === 0 || input.includes("\0")) {
    throw new Error("Source must not be empty or contain NUL");
  }
  const local = path.resolve(options.cwd, input);
  if (!looksRemote(input)) {
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
  return source;
};

const acquireSource = async (source: Source, scratchParent: string): Promise<AcquiredSource> => {
  if (source.kind === "git") {
    validateGitSource(source, true);
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
