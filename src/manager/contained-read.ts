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
  if (process.platform !== "linux") {
    throw new Error(
      "Secure file containment requires Linux with /proc/self/fd; plugin management is unavailable on this platform",
    );
  }
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
    const opened = await realpath(`/proc/self/fd/${handle.fd}`);
    if (opened !== path || !opened.startsWith(`${root}${pathModule.sep}`)) {
      throw new Error("Opened source file escaped its root");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export { openContainedFile };
