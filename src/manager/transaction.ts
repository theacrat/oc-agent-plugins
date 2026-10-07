import { rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkStage, exists } from "./paths.ts";
import type { StageOwner } from "./paths.ts";

type Boundary = "staged" | "journalled" | "backed-up" | "committed";
interface Transaction {
  readonly state: string;
  readonly source: string;
  readonly target?: string;
  readonly backup?: string;
  readonly stage?: string;
  readonly verify: (directory: string) => Promise<void>;
  readonly verifyStage?: (directory: string) => Promise<void>;
  readonly destroy: (directory: string) => Promise<void>;
  readonly boundary?: ((boundary: Boundary) => Promise<void>) | undefined;
}

function snapshotTransaction(
  state: string,
  verify: Transaction["verify"],
  boundary: Transaction["boundary"],
  owner?: StageOwner,
  stage?: string,
) {
  return {
    boundary,
    destroy: async (directory: string) => {
      if (owner && directory === stage) {
        await checkStage(directory, owner);
      }
      await verify(directory);
      if (owner && directory === stage) {
        await checkStage(directory, owner);
      }
      await rm(directory, { recursive: true });
    },
    state,
    verify,
    ...(owner ? { verifyStage: async (directory: string) => checkStage(directory, owner) } : {}),
  };
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

async function checkRollback(destination: string, cause: unknown): Promise<void> {
  if (await exists(destination)) {
    throw new Error("Rollback collision; transaction journal retained", { cause });
  }
}

async function verifyOwnedStage(transaction: Transaction, directory: string): Promise<void> {
  if (transaction.stage) {
    await transaction.verifyStage?.(directory);
  }
}

async function rollback(
  transaction: Transaction,
  committed: boolean,
  backedUp: boolean,
  error: unknown,
) {
  const { source, target, backup, stage, verify, destroy } = transaction;
  if (committed && target) {
    await verifyOwnedStage(transaction, target);
    await verify(target);
    await checkRollback(stage ?? source, error);
    await verifyOwnedStage(transaction, target);
    await rename(target, stage ?? source);
  }
  if (backedUp && backup) {
    await verify(backup);
    await checkRollback(source, error);
    await rename(backup, source);
  }
  if (stage && (await exists(stage))) {
    await verifyOwnedStage(transaction, stage);
    await destroy(stage);
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
    await verifyOwnedStage(transaction, stage ?? source);
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
      await verifyOwnedStage(transaction, stage ?? source);
      await rename(stage ?? source, target);
      committed = true;
    }
    await boundary?.("committed");
    if (target) {
      await verifyOwnedStage(transaction, target);
    }
  } catch (error) {
    // A failed rollback deliberately keeps the journal, rather than guessing ownership.
    await rollback(transaction, committed, backedUp, error);
    await unlink(journal);
    throw error;
  }
  // Cleanup failures retain the journal and the verified backup for manual recovery.
  await cleanupBackup(backup, destroy);
  await unlink(journal);
}

export type { Boundary };
export { snapshotTransaction, transact };
