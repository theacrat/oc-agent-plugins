import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { withLock } from "./lock.ts";
import {
  exists,
  safeDirectory,
  stateInventory,
  storePaths,
  validateName,
  validateSource,
  validateTree,
} from "./paths.ts";
import { assertUpdateReceipt, readReceipt, writeReceipt } from "./receipt.ts";
import { transact } from "./transaction.ts";
import { RECEIPT } from "./types.ts";
import type { AcquiredSource, Installation, PluginMetadata, Receipt } from "./types.ts";

const { basename, join } = path;

interface StoreDependencies {
  readonly readMetadata: (directory: string) => Promise<PluginMetadata | undefined>;
  readonly snapshotDirectory: (source: string, destination: string) => Promise<void>;
  // Fingerprints must exclude RECEIPT and include all remaining snapshot files.
  readonly fingerprintDirectory: (directory: string) => Promise<string>;
  readonly boundary?: Parameters<typeof transact>[0]["boundary"];
}

async function assessSnapshot(directory: string, deps: StoreDependencies) {
  const receipt = await readReceipt(directory);
  const resolved = await deps.readMetadata(directory);
  if (
    resolved?.manifest.name !== receipt.name ||
    resolved.format !== receipt.format ||
    resolved.manifest.version !== receipt.version
  ) {
    throw new Error("Receipt and manifest identity do not match");
  }
  await validateTree(directory);
  const edited = (await deps.fingerprintDirectory(directory)) !== receipt.fingerprint;
  return { edited, metadata: resolved, receipt };
}

async function inspect(
  directory: string,
  enabled: boolean,
  deps: StoreDependencies,
): Promise<Installation> {
  const installation = { directory, enabled, name: basename(directory) };
  try {
    await safeDirectory(directory);
    if (!(await exists(join(directory, RECEIPT)))) {
      const metadata = await deps.readMetadata(directory);
      return { ...installation, managed: false, ...(metadata ? { metadata } : {}) };
    }
    const { edited, ...snapshot } = await assessSnapshot(directory, deps);
    if (snapshot.receipt.name !== installation.name) {
      throw new Error("Receipt and manifest identity do not match");
    }
    return {
      ...installation,
      ...snapshot,
      managed: true,
      ...(edited ? { problem: "Installation payload has local edits" } : {}),
    };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    return { ...installation, managed: false, problem };
  }
}

async function listInstallations(root: string, deps: StoreDependencies): Promise<Installation[]> {
  const roots = storePaths(root);
  const locations = [roots.active, roots.disabled];
  const groups = await Promise.all(
    locations.map(async (directory) => {
      if (!(await exists(directory))) {
        return [];
      }
      await safeDirectory(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map(async (entry) =>
            inspect(join(directory, entry.name), directory === roots.active, deps),
          ),
      );
    }),
  );
  const result = [...groups.flat(), ...(await stateInventory(roots.state))];
  return result.toSorted((left, right) => left.name.localeCompare(right.name));
}

async function find(root: string, name: string, deps: StoreDependencies): Promise<Installation> {
  validateName(name);
  const inventory = await listInstallations(root, deps);
  const entries = inventory.filter((entry) => entry.name === name);
  const [entry] = entries;
  if (entries.length !== 1 || !entry) {
    throw new Error(`Missing or conflicting installation: ${name}`);
  }
  if (!entry.managed || entry.problem) {
    throw new Error(
      `Refusing to modify ${entry.directory}: ${entry.problem ?? "unmanaged installation"}`,
    );
  }
  return entry;
}

async function verifySnapshot(directory: string, deps: StoreDependencies): Promise<void> {
  const { edited } = await assessSnapshot(directory, deps);
  if (edited) {
    throw new Error(`Unowned or edited snapshot: ${directory}`);
  }
}

async function destroy(directory: string, deps: StoreDependencies): Promise<void> {
  await verifySnapshot(directory, deps);
  await rm(directory, { recursive: true });
}

function transactionOptions(root: string, deps: StoreDependencies) {
  return {
    boundary: deps.boundary,
    destroy: async (directory: string) => destroy(directory, deps),
    state: storePaths(root).state,
    verify: async (directory: string) => verifySnapshot(directory, deps),
  };
}

async function stagedReceipt(
  stage: string,
  acquired: AcquiredSource,
  deps: StoreDependencies,
  previous?: Receipt,
) {
  await validateTree(stage);
  if (await exists(join(stage, RECEIPT))) {
    throw new Error("Source contains a manager receipt; refusing adoption");
  }
  const metadata = await deps.readMetadata(stage);
  if (!metadata) {
    throw new Error("Source has no supported plugin manifest");
  }
  validateName(metadata.manifest.name);
  const identity = previous ?? { format: metadata.format, name: metadata.manifest.name };
  if (identity.name !== metadata.manifest.name || identity.format !== metadata.format) {
    throw new Error("Update cannot change plugin name or format");
  }
  const receipt: Receipt = {
    fingerprint: await deps.fingerprintDirectory(stage),
    format: metadata.format,
    name: metadata.manifest.name,
    ...(acquired.revision ? { revision: acquired.revision } : {}),
    schemaVersion: 1,
    source: acquired.source,
    ...(metadata.manifest.version === undefined ? {} : { version: metadata.manifest.version }),
  };
  await writeReceipt(stage, receipt);
  return receipt;
}

async function checkStage(stage: string, handle: FileHandle): Promise<void> {
  await safeDirectory(path.dirname(stage));
  const original = await handle.stat();
  const current = await lstat(stage);
  const sameIdentity = current.dev === original.dev && current.ino === original.ino;
  if (!current.isDirectory() || !sameIdentity) {
    throw new Error(`Staging directory replaced; retained for inspection: ${stage}`);
  }
}

async function cleanupStage(stage: string, handle: FileHandle): Promise<void> {
  if (!(await exists(stage))) {
    return;
  }
  await checkStage(stage, handle);
  // Only this exact mkdtemp directory is owned. rm unlinks nested symlinks, never their targets.
  await rm(stage, { recursive: true });
}

async function stageSource(
  root: string,
  acquired: AcquiredSource,
  deps: StoreDependencies,
  previous?: Receipt,
) {
  const { state } = storePaths(root);
  await validateSource(acquired.directory, Object.values(storePaths(root)));
  const stage = await mkdtemp(join(state, "stage-"));
  const handle = await open(stage, "r");
  let receipt: Receipt | undefined;
  try {
    await deps.snapshotDirectory(acquired.directory, stage);
    await checkStage(stage, handle);
    receipt = await stagedReceipt(stage, acquired, deps, previous);
    await deps.boundary?.("staged");
    await checkStage(stage, handle);
    return { receipt, stage };
  } catch (error) {
    if (!(await exists(join(state, "journal.json")))) {
      if (receipt) {
        const snapshot = await assessSnapshot(stage, deps);
        assertUpdateReceipt(snapshot.receipt, receipt.source, receipt);
        if (snapshot.edited) {
          throw new Error(`Edited staging snapshot retained for inspection: ${stage}`, {
            cause: error,
          });
        }
      }
      await cleanupStage(stage, handle);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function install(root: string, acquired: AcquiredSource, deps: StoreDependencies) {
  return withLock(root, async () => {
    const { stage, receipt } = await stageSource(root, acquired, deps);
    const { active, disabled, state } = storePaths(root);
    const target = join(active, receipt.name);
    try {
      if ((await exists(target)) || (await exists(join(disabled, receipt.name)))) {
        throw new Error(`Installation already exists: ${receipt.name}`);
      }
      await transact({
        ...transactionOptions(root, deps),
        source: stage,
        stage,
        target,
      });
    } catch (error) {
      if (!(await exists(join(state, "journal.json"))) && (await exists(stage))) {
        await destroy(stage, deps);
      }
      throw error;
    }
    return inspect(target, true, deps);
  });
}

async function update(
  root: string,
  name: string,
  acquired: AcquiredSource,
  deps: StoreDependencies,
  expectedReceipt?: Receipt,
) {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    assertUpdateReceipt(previous.receipt, acquired.source, expectedReceipt);
    const { stage } = await stageSource(root, acquired, deps, previous.receipt);
    await transact({
      ...transactionOptions(root, deps),
      backup: `${stage}.backup`,
      source: previous.directory,
      stage,
      target: previous.directory,
    });
    return inspect(previous.directory, previous.enabled, deps);
  });
}

async function setEnabled(root: string, name: string, enabled: boolean, deps: StoreDependencies) {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    if (previous.enabled === enabled) {
      return previous;
    }
    const target = join(storePaths(root)[enabled ? "active" : "disabled"], name);
    await transact({
      ...transactionOptions(root, deps),
      source: previous.directory,
      target,
    });
    return inspect(target, enabled, deps);
  });
}

async function removeInstallation(root: string, name: string, deps: StoreDependencies) {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    await transact({
      ...transactionOptions(root, deps),
      backup: join(storePaths(root).state, `remove-${name}`),
      source: previous.directory,
    });
  });
}

interface StoreDiagnostics {
  readonly installations: readonly Installation[];
  readonly problems: readonly string[];
}

async function doctor(root: string, deps: StoreDependencies): Promise<StoreDiagnostics> {
  const installations = await listInstallations(root, deps);
  const problems = installations.flatMap((entry) => {
    if (!entry.problem) {
      return [];
    }
    return entry.directory === storePaths(root).state
      ? entry.problem.split("\n")
      : [`${entry.name}: ${entry.problem}`];
  });
  const duplicateNames = installations
    .map((entry) => entry.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  problems.push(
    ...duplicateNames.map((name) => `Conflicting active/disabled installation: ${name}`),
  );
  return { installations, problems };
}

export type { StoreDependencies, StoreDiagnostics };
export { doctor, install, listInstallations, removeInstallation, setEnabled, update };
