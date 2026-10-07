import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import pathModule from "node:path";

interface ReadIdentity {
  readonly file: Stats;
  readonly parents: ReadonlyMap<string, Stats>;
}

const identities = new WeakMap<FileHandle, ReadIdentity>();
const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const parentIdentities = async (
  path: string,
  root: string,
): Promise<ReadonlyMap<string, Stats>> => {
  const relative = pathModule.relative(root, path);
  if (
    relative === "" ||
    relative.startsWith(`..${pathModule.sep}`) ||
    relative === ".." ||
    pathModule.isAbsolute(relative)
  ) {
    throw new Error("Source path escaped its root");
  }
  const parents = new Map<string, Stats>();
  let parent = root;
  for (const segment of ["", ...relative.split(pathModule.sep).slice(0, -1)]) {
    parent = pathModule.join(parent, segment);
    // Ancestors must remain real directories, including Windows junctions.
    // eslint-disable-next-line eslint/no-await-in-loop
    const info = await lstat(parent);
    // eslint-disable-next-line eslint/no-await-in-loop
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent) {
      throw new Error("Source parent changed or escaped its root");
    }
    parents.set(parent, info);
  }
  return parents;
};

const verifyDescriptorPath = async (handle: FileHandle, path: string): Promise<void> => {
  if (process.platform !== "linux") {
    return;
  }
  try {
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== path) {
      throw new Error("Opened source file escaped its root");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
};

const verifyContainedRead = async (
  handle: FileHandle,
  path: string,
  root: string,
): Promise<void> => {
  const expected = identities.get(handle);
  if (expected === undefined) {
    throw new Error("Source file has no acquisition identity");
  }
  const parents = await parentIdentities(path, root);
  for (const [parent, info] of parents) {
    const baseline = expected.parents.get(parent);
    if (baseline === undefined || !sameIdentity(baseline, info)) {
      throw new Error("Source parent changed during acquisition");
    }
  }
  const current = await lstat(path);
  const opened = await handle.stat();
  if (
    !current.isFile() ||
    !opened.isFile() ||
    !sameIdentity(expected.file, current) ||
    !sameIdentity(expected.file, opened) ||
    current.size !== expected.file.size ||
    opened.size !== expected.file.size ||
    current.mtimeMs !== expected.file.mtimeMs ||
    opened.mtimeMs !== expected.file.mtimeMs ||
    current.ctimeMs !== expected.file.ctimeMs ||
    opened.ctimeMs !== expected.file.ctimeMs ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Source file changed during acquisition");
  }
  await verifyDescriptorPath(handle, path);
};

const openContainedFile = async (path: string, root: string): Promise<FileHandle> => {
  const parents = await parentIdentities(path, root);
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new Error("Source must be a regular file");
  }
  // Windows does not expose O_NOFOLLOW; identity and path checks remain mandatory.
  // eslint-disable-next-line eslint/no-bitwise
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  identities.set(handle, { file: expected, parents });
  try {
    await verifyContainedRead(handle, path, root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export { openContainedFile, verifyContainedRead };
