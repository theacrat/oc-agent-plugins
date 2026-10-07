import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import pathModule from "node:path";
// Node's callback subprocess API is adapted once at the execution boundary.
import { promisify } from "node:util";

import { forEachSequential } from "#src/manager/sequence.ts";
import {
  EXCLUDED,
  MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  safeRelativePath,
  writeSnapshotFile,
} from "#src/manager/snapshot.ts";
import { RECEIPT } from "#src/manager/types.ts";
import type { AcquiredSource, Source } from "#src/manager/types.ts";

// Node exposes a custom promisify overload for execFile despite its void callback signature.
// eslint-disable-next-line typescript/strict-void-return
const executeFile = promisify(execFile);

const gitPath = (scratch: string, name: string): string =>
  pathModule.join(scratch, name).split(pathModule.sep).join("/");

const gitEnvironment = (scratch: string): Record<string, string> => ({
  GIT_CONFIG_GLOBAL: gitPath(scratch, "empty.config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_SSH_COMMAND: `ssh -F '${gitPath(scratch, "empty.config").replaceAll("'", String.raw`'\''`)}' -oBatchMode=yes -oPermitLocalCommand=no -oClearAllForwardings=yes`,
  GIT_TERMINAL_PROMPT: "0",
  HOME: scratch,
  // Only executable discovery is inherited, not Git or SSH configuration.
  // eslint-disable-next-line node/no-process-env
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  // Git for Windows needs system executable discovery, not user configuration.
  // eslint-disable-next-line node/no-process-env
  ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
});

const repositorySize = async (directory: string): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const child = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) {
        return repositorySize(child);
      }
      try {
        const info = await stat(child);
        return info.size;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return 0;
        }
        throw error;
      }
    }),
  );
  let total = 0;
  for (const size of sizes) {
    total += size;
  }
  return total;
};

const fetchRepository = async (
  scratch: string,
  source: Extract<Source, { kind: "git" }>,
  deadline: number,
  run: typeof git,
): Promise<void> => {
  const controller = new AbortController();
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      if ((await repositorySize(pathModule.join(scratch, "repository"))) > MAX_BYTES) {
        controller.abort();
      }
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => {
    void check();
  }, 50);
  try {
    await run(
      scratch,
      [
        "--git-dir=repository",
        "fetch",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        source.url,
        source.ref ?? "HEAD",
      ],
      deadline,
      controller.signal,
    );
    if ((await repositorySize(pathModule.join(scratch, "repository"))) > MAX_BYTES) {
      throw new Error("Git repository exceeds size limit");
    }
  } finally {
    clearInterval(timer);
  }
};
async function git(
  scratch: string,
  args: readonly string[],
  deadline: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (Date.now() >= deadline) {
    throw new Error("Git acquisition exceeded runtime limit");
  }
  try {
    const result = await executeFile(
      "git",
      [
        `--git-dir=${pathModule.join(scratch, "repository")}`,
        "-c",
        `core.hooksPath=${gitPath(scratch, "empty-hooks")}`,
        "-c",
        `core.attributesFile=${gitPath(scratch, "empty.config")}`,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "protocol.file.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      {
        cwd: scratch,
        encoding: "buffer",
        env: gitEnvironment(scratch),
        maxBuffer: MAX_FILE_BYTES + 1,
        ...(signal === undefined ? {} : { signal }),
        timeout: Math.min(30_000, deadline - Date.now()),
      },
    );
    return result.stdout;
  } catch (error) {
    throw new Error("Git acquisition failed", { cause: error });
  }
}

const treeEntries = (tree: Buffer): readonly string[] => {
  if (!Buffer.from(tree.toString("utf8"), "utf8").equals(tree)) {
    throw new Error("Git tree paths must be valid UTF-8");
  }
  const entries = tree.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > MAX_FILES) {
    throw new Error("Git source exceeds file count limit");
  }
  return entries;
};

const extractBlob = async (
  scratch: string,
  directory: string,
  object: string,
  length: number,
  selected: string,
  mode: string,
  deadline: number,
): Promise<void> => {
  const content = await git(
    scratch,
    ["--git-dir=repository", "cat-file", "blob", object],
    deadline,
  );
  if (content.length !== length) {
    throw new Error("Git blob size mismatch");
  }
  await writeSnapshotFile(directory, {
    content,
    executable: mode === "100755" ? 0o111 : 0,
    kind: "file",
    path: selected,
  });
};

const extractTree = async (
  scratch: string,
  directory: string,
  tree: Buffer,
  subdir: string | undefined,
  deadline: number,
): Promise<void> => {
  let bytes = 0;
  let selectedFiles = 0;
  const prefix = subdir === undefined ? "" : `${subdir}/`;
  await forEachSequential(treeEntries(tree), async (entry) => {
    const matched =
      /^(?<mode>\d+) (?<type>\w+) (?<object>[a-f0-9]+)\s+(?<size>\d+|-)\t(?<path>.+)$/su.exec(
        entry,
      );
    if (!matched?.groups) {
      throw new Error("Invalid Git tree entry");
    }
    const { mode, type, object, size, path } = matched.groups;
    if (path === undefined || !safeRelativePath(path)) {
      throw new Error("Unsafe Git tree path");
    }
    if (!path.startsWith(prefix)) {
      return;
    }
    const selected = path.slice(prefix.length);
    const segments = selected.split("/");
    if (segments.some((part) => EXCLUDED.has(part))) {
      return;
    }
    if (segments.includes(RECEIPT)) {
      throw new Error("Git source contains reserved receipt");
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || object === undefined) {
      throw new Error("Git links, submodules and special files are not supported");
    }
    const length = Number(size);
    bytes += length;
    if (!Number.isSafeInteger(length) || length > MAX_FILE_BYTES || bytes > MAX_BYTES) {
      throw new Error("Git source exceeds size limit");
    }
    await extractBlob(scratch, directory, object, length, selected, mode, deadline);
    selectedFiles += 1;
  });
  if (selectedFiles === 0) {
    throw new Error("Git source subdirectory is missing or contains no supported files");
  }
};

const acquireGitSource = async (
  source: Extract<Source, { kind: "git" }>,
  scratchParent: string,
): Promise<AcquiredSource> => {
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(pathModule.join(await realpath(scratchParent), "source-"));
  const deadline = Date.now() + 60_000;
  const dispose = async (): Promise<void> => {
    await rm(scratch, { force: true, recursive: true });
  };
  try {
    await writeFile(pathModule.join(scratch, "empty.config"), "", { flag: "wx", mode: 0o600 });
    await mkdir(pathModule.join(scratch, "empty-hooks"));
    await git(scratch, ["init", "--bare", "--template=", "repository"], deadline);
    await fetchRepository(scratch, source, deadline, git);
    const resolved = await git(
      scratch,
      ["--git-dir=repository", "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      deadline,
    );
    const revision = resolved.toString("utf8").trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) {
      throw new Error("Invalid resolved Git commit");
    }
    const tree = await git(
      scratch,
      ["--git-dir=repository", "ls-tree", "-rzl", revision],
      deadline,
    );
    const directory = pathModule.join(scratch, "snapshot");
    await mkdir(directory);
    await extractTree(scratch, directory, tree, source.subdir, deadline);
    return { directory, dispose, revision, source };
  } catch (error) {
    await dispose();
    throw error;
  }
};

export { acquireGitSource };
