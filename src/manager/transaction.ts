import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { exists } from "./paths.ts";

type Boundary = "staged" | "journalled" | "backed-up" | "committed";
interface Transaction {
  readonly state: string;
  readonly source: string;
  readonly target?: string;
  readonly backup?: string;
  readonly stage?: string;
  readonly verify: (directory: string) => Promise<void>;
  readonly destroy: (directory: string) => Promise<void>;
  readonly boundary?: ((boundary: Boundary) => Promise<void>) | undefined;
}

async function cleanupBackup(
  backup: string | undefined,
  destroy: (directory: string) => Promise<void>,
): Promise<void> {
  if (backup) {
    await destroy(backup);
  }
}

async function checkTarget(source: string, target: string | undefined): Promise<void> {
  if (target && target !== source && (await exists(target))) {
    throw new Error(`Installation collision: ${target}`);
  }
}

async function transact(transaction: Transaction): Promise<void> {
  const { source, target, backup, stage, state, verify, destroy, boundary } = transaction;
  const journal = path.join(state, "journal.json");
  await writeFile(journal, JSON.stringify({ backup, schemaVersion: 1, source, stage, target }), {
    flag: "wx",
  });
  let backedUp = false;
  let committed = false;
  try {
    await boundary?.("journalled");
    await verify(source);
    await verify(stage ?? source);
    await checkTarget(source, target);
    if (backup) {
      if (await exists(backup)) {
        throw new Error("Transaction backup already exists");
      }
      await rename(source, backup);
      backedUp = true;
      await boundary?.("backed-up");
    }
    if (target) {
      await rename(stage ?? source, target);
      committed = true;
    }
    await boundary?.("committed");
  } catch (error) {
    // A failed rollback deliberately keeps the journal, rather than guessing ownership.
    if (committed && target) {
      await verify(target);
      await rename(target, stage ?? source);
    }
    if (backedUp && backup) {
      await verify(backup);
      if (await exists(source)) {
        throw new Error("Rollback collision; transaction journal retained", { cause: error });
      }
      await rename(backup, source);
    }
    if (stage && (await exists(stage))) {
      await destroy(stage);
    }
    await unlink(journal);
    throw error;
  }
  // Cleanup failures retain the journal and the verified backup for manual recovery.
  await cleanupBackup(backup, destroy);
  await unlink(journal);
}

export type { Boundary };
export { transact };
