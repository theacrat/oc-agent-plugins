import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import pathModule from "node:path";

const containedPath = async (path: string, root: string): Promise<void> => {
  const resolved = await realpath(path);
  if (
    resolved !== path ||
    (resolved !== root && !resolved.startsWith(`${root}${pathModule.sep}`))
  ) {
    throw new Error("Source path changed or escaped its root");
  }
};

const openContainedFile = async (path: string, root: string): Promise<FileHandle> => {
  await containedPath(pathModule.dirname(path), root);
  const expected = await lstat(path);
  // Reject a replaced final component and verify the actual opened object before reading bytes.
  // eslint-disable-next-line eslint/no-bitwise
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!expected.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error("Source file changed during acquisition");
    }
    if (process.platform === "linux") {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (opened !== path || !opened.startsWith(`${root}${pathModule.sep}`)) {
        throw new Error("Opened source file escaped its root");
      }
    } else {
      // Node has no portable openat/F_GETPATH API. These identity checks detect replacements,
      // but an adversarial ABA parent swap is only provably contained by the Linux FD check.
      await containedPath(pathModule.dirname(path), root);
      const current = await lstat(path);
      if (current.dev !== actual.dev || current.ino !== actual.ino) {
        throw new Error("Source file changed during acquisition");
      }
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export { openContainedFile };
