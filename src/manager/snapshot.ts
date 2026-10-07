import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import pathModule from "node:path";

import { openContainedFile, verifyContainedRead } from "#src/manager/contained-read.ts";
import { forEachSequential } from "#src/manager/sequence.ts";
import { RECEIPT } from "#src/manager/types.ts";

const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const EXCLUDED = new Set([".git", "node_modules"]);

interface DirectoryFile {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly content: Buffer;
  readonly executable: number;
}

const ignoredEntry = (name: string, rejectReceipt: boolean, rootEntry: boolean): boolean => {
  if (name === RECEIPT && rejectReceipt) {
    throw new Error("Source contains reserved receipt");
  }
  return rejectReceipt ? EXCLUDED.has(name) : name === RECEIPT && rootEntry;
};

const executableBits = (mode: number): number =>
  process.platform === "win32"
    ? 0
    : (Math.floor(mode / 0o100) % 2) * 0o100 + (Math.floor(mode / 0o10) % 2) * 0o10 + (mode % 2);

const requireDirectory = async (directory: string): Promise<void> => {
  const stat = await lstat(directory);
  if (!stat.isDirectory()) {
    throw new Error(`Source is not a directory: ${directory}`);
  }
};

const sortedFiles = (files: readonly DirectoryFile[]): readonly DirectoryFile[] =>
  files.toSorted((left, right) => (left.path < right.path ? -1 : Number(left.path > right.path)));

const safeRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes("\\") &&
  !path.includes(":") &&
  !Array.from({ length: 32 }, (_unused, code) => String.fromCodePoint(code)).some((control) =>
    path.includes(control),
  ) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const readRegularFile = async (path: string, root?: string): Promise<Buffer> => {
  const canonicalRoot = root ?? (await realpath(pathModule.dirname(path)));
  const canonicalPath =
    root === undefined ? pathModule.join(canonicalRoot, pathModule.basename(path)) : path;
  const handle = await openContainedFile(canonicalPath, canonicalRoot);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error(`Unsafe or oversized file: ${path}`);
    }
    const content = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < content.length) {
      // Reads must advance the same bounded buffer sequentially.
      // eslint-disable-next-line eslint/no-await-in-loop
      const result = await handle.read(content, length, content.length - length, length);
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    if (length > stat.size) {
      throw new Error(`File changed while reading: ${path}`);
    }
    await verifyContainedRead(handle, canonicalPath, canonicalRoot);
    return content.subarray(0, length);
  } finally {
    await handle.close();
  }
};

const requireUnchangedDirectory = async (directory: string): Promise<void> => {
  if ((await realpath(directory)) !== directory) {
    throw new Error(`Source directory changed: ${directory}`);
  }
};

const fileEntry = (path: string, content: Buffer, mode: number): DirectoryFile => ({
  content,
  executable: executableBits(mode),
  kind: "file",
  path,
});

const directoryFiles = async (
  directory: string,
  rejectReceipt: boolean,
): Promise<readonly DirectoryFile[]> => {
  const root = await realpath(directory);
  await requireDirectory(root);
  const files: DirectoryFile[] = [];
  let totalBytes = 0;
  let entries = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) {
      throw new Error("Source exceeds directory depth limit");
    }
    const names = await readdir(path);
    await forEachSequential(names.toSorted(), async (name) => {
      entries += 1;
      if (entries > MAX_FILES) {
        throw new Error("Source exceeds file count limit");
      }
      if (ignoredEntry(name, rejectReceipt, depth === 0)) {
        return;
      }
      const child = pathModule.join(path, name);
      const childPath = pathModule.relative(root, child).split(pathModule.sep).join("/");
      if (!safeRelativePath(childPath)) {
        throw new Error(`Unsafe source path: ${childPath}`);
      }
      const stat = await lstat(child);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Links and special files are not supported: ${child}`);
      }
      if (stat.isDirectory()) {
        await requireUnchangedDirectory(child);
        files.push({ content: Buffer.alloc(0), executable: 0, kind: "directory", path: childPath });
        await walk(child, depth + 1);
      } else {
        const content = await readRegularFile(child, root);
        totalBytes += content.length;
        if (totalBytes > MAX_BYTES) {
          throw new Error("Source exceeds size limit");
        }
        files.push(fileEntry(childPath, content, stat.mode));
      }
    });
  };
  await walk(root, 0);
  return sortedFiles(files);
};

const writeSnapshotFile = async (root: string, file: DirectoryFile): Promise<void> => {
  if (!safeRelativePath(file.path)) {
    throw new Error(`Unsafe snapshot path: ${file.path}`);
  }
  const parts = file.path.split("/");
  let parent = root;
  await forEachSequential(parts.slice(0, -1), async (part) => {
    parent = pathModule.join(parent, part);
    await mkdir(parent, { recursive: true });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || (await realpath(parent)) !== parent) {
      throw new Error(`Unsafe destination directory: ${parent}`);
    }
  });
  const destination = pathModule.join(root, file.path);
  if (file.kind === "directory") {
    await mkdir(destination);
    return;
  }
  const mode = 0o644 + (process.platform === "win32" ? 0 : file.executable);
  const handle = await open(destination, "wx", mode);
  try {
    await handle.writeFile(file.content);
  } finally {
    await handle.close();
  }
  await chmod(destination, mode);
};

const createDestination = async (directory: string, ancestor = false): Promise<string> => {
  try {
    if (ancestor) {
      return await createDestination(await realpath(directory));
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Snapshot destination must be an empty, real directory");
    }
    return await realpath(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    const parent = await createDestination(pathModule.dirname(directory), true);
    const destination = pathModule.join(parent, pathModule.basename(directory));
    await mkdir(destination);
    return destination;
  }
};

const snapshotDirectory = async (source: string, destination: string): Promise<void> => {
  const root = await realpath(source);
  const resolved = pathModule.resolve(destination);
  if (resolved === root || resolved.startsWith(`${root}${pathModule.sep}`)) {
    throw new Error("Snapshot destination must be outside the source");
  }
  const files = await directoryFiles(root, true);
  const target = await createDestination(resolved);
  if (target === root || target.startsWith(`${root}${pathModule.sep}`)) {
    throw new Error("Snapshot destination must be outside the source");
  }
  const entries = await readdir(target);
  if ((await realpath(target)) !== target || entries.length > 0) {
    throw new Error("Snapshot destination must be an empty, real directory");
  }
  await forEachSequential(files, async (file) => writeSnapshotFile(target, file));
};

export type { DirectoryFile };
export {
  directoryFiles,
  EXCLUDED,
  MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  readRegularFile,
  safeRelativePath,
  snapshotDirectory,
  writeSnapshotFile,
};
