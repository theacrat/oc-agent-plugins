import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { exists, safeDirectory, storePaths } from "./paths.ts";

const { join } = path;

async function withLock<Result>(root: string, run: () => Promise<Result>): Promise<Result> {
  const paths = storePaths(root);
  await safeDirectory(paths.state, true);
  const lock = join(paths.state, "lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Store is locked: ${lock}. Inspect the owner before manually recovering it.`,
        { cause: error },
      );
    }
    throw error;
  }
  const owner = join(lock, "owner.json");
  try {
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
      { flag: "wx" },
    );
    if (await exists(join(paths.state, "journal.json"))) {
      throw new Error(
        "Interrupted transaction detected; inspect journal.json and recover owned paths before retrying",
      );
    }
    await safeDirectory(paths.active, true);
    await safeDirectory(paths.disabled, true);
    return await run();
  } finally {
    if (await exists(owner)) {
      await unlink(owner);
    }
    await rmdir(lock);
  }
}

export { withLock };
