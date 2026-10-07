import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import type { Boundary } from "./transaction.ts";
import { RECEIPT } from "./types.ts";
import type { AcquiredSource, Installation, PluginMetadata, Receipt } from "./types.ts";

const { basename, join } = path;

interface StoreDependencies {
  readonly readMetadata: (directory: string) => Promise<PluginMetadata | undefined>;
  readonly snapshotDirectory: (source: string, destination: string) => Promise<void>;
  // Fingerprints must exclude RECEIPT and include all remaining snapshot files.
  readonly fingerprintDirectory: (directory: string) => Promise<string>;
  readonly boundary?: (boundary: Boundary) => Promise<void>;
}

async function inspect(
  directory: string,
  enabled: boolean,
  deps: StoreDependencies,
): Promise<Installation> {
  const name = basename(directory);
  try {
    await safeDirectory(directory);
    const metadata = await deps.readMetadata(directory);
    if (!(await exists(join(directory, RECEIPT)))) {
      return { directory, enabled, managed: false, name, ...(metadata ? { metadata } : {}) };
    }
    const receipt = await readReceipt(directory);
    if (
      receipt.name !== name ||
      metadata?.manifest.name !== name ||
      metadata.format !== receipt.format ||
      metadata.manifest.version !== receipt.version
    ) {
      throw new Error("Receipt and manifest identity do not match");
    }
    await validateTree(directory);
    const edited = (await deps.fingerprintDirectory(directory)) !== receipt.fingerprint;
    return {
      directory,
      enabled,
      managed: true,
      metadata,
      name,
      receipt,
      ...(edited ? { problem: "Installation payload has local edits" } : {}),
    };
  } catch (error) {
    return {
      directory,
      enabled,
      managed: false,
      name,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

async function listInstallations(root: string, deps: StoreDependencies): Promise<Installation[]> {
  const paths = storePaths(root);
  const groups = await Promise.all(
    (
      [
        [paths.active, true],
        [paths.disabled, false],
      ] as const
    ).map(async ([directory, enabled]) => {
      if (!(await exists(directory))) {
        return [];
      }
      await safeDirectory(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map(async (entry) => inspect(join(directory, entry.name), enabled, deps)),
      );
    }),
  );
  const result = [...groups.flat(), ...(await stateInventory(paths.state))];
  return result.toSorted((left, right) => left.name.localeCompare(right.name));
}

async function owned(directory: string, deps: StoreDependencies): Promise<Installation> {
  const installation = await inspect(directory, true, deps);
  if (!installation.managed || installation.problem) {
    throw new Error(
      `Refusing to modify ${directory}: ${installation.problem ?? "unmanaged installation"}`,
    );
  }
  return installation;
}

async function find(root: string, name: string, deps: StoreDependencies): Promise<Installation> {
  validateName(name);
  const inventory = await listInstallations(root, deps);
  const entries = inventory.filter((entry) => entry.name === name);
  if (entries.length !== 1) {
    throw new Error(`Missing or conflicting installation: ${name}`);
  }
  const [entry] = entries;
  if (!entry) {
    throw new Error(`Missing installation: ${name}`);
  }
  await owned(entry.directory, deps);
  return entry;
}

async function verifySnapshot(directory: string, deps: StoreDependencies): Promise<void> {
  await validateTree(directory);
  const receipt = await readReceipt(directory);
  const metadata = await deps.readMetadata(directory);
  if (
    metadata?.manifest.name !== receipt.name ||
    metadata.format !== receipt.format ||
    metadata.manifest.version !== receipt.version ||
    (await deps.fingerprintDirectory(directory)) !== receipt.fingerprint
  ) {
    throw new Error(`Unowned or edited snapshot: ${directory}`);
  }
}

async function destroy(directory: string, deps: StoreDependencies): Promise<void> {
  await verifySnapshot(directory, deps);
  await rm(directory, { recursive: true });
}

async function stageSource(
  root: string,
  acquired: AcquiredSource,
  deps: StoreDependencies,
  previous?: Receipt,
): Promise<{ stage: string; receipt: Receipt }> {
  const paths = storePaths(root);
  await validateSource(acquired.directory, [paths.active, paths.disabled, paths.state]);
  const stage = await mkdtemp(join(paths.state, "stage-"));
  await deps.snapshotDirectory(acquired.directory, stage);
  await validateTree(stage);
  if (await exists(join(stage, RECEIPT))) {
    throw new Error("Source contains a manager receipt; refusing adoption");
  }
  const metadata = await deps.readMetadata(stage);
  if (!metadata) {
    throw new Error("Source has no supported plugin manifest");
  }
  validateName(metadata.manifest.name);
  if (
    previous &&
    (previous.name !== metadata.manifest.name || previous.format !== metadata.format)
  ) {
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
  try {
    await deps.boundary?.("staged");
  } catch (error) {
    await destroy(stage, deps);
    throw error;
  }
  return { receipt, stage };
}

async function install(
  root: string,
  acquired: AcquiredSource,
  deps: StoreDependencies,
): Promise<Installation> {
  return withLock(root, async () => {
    const paths = storePaths(root);
    const { stage, receipt } = await stageSource(root, acquired, deps);
    const target = join(paths.active, receipt.name);
    try {
      if ((await exists(target)) || (await exists(join(paths.disabled, receipt.name)))) {
        throw new Error(`Installation already exists: ${receipt.name}`);
      }
      await transact({
        boundary: deps.boundary,
        destroy: async (directory) => destroy(directory, deps),
        source: stage,
        stage,
        state: paths.state,
        target,
        verify: async (directory) => verifySnapshot(directory, deps),
      });
    } catch (error) {
      if (!(await exists(join(paths.state, "journal.json"))) && (await exists(stage))) {
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
): Promise<Installation> {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    assertUpdateReceipt(previous.receipt, acquired.source, expectedReceipt);
    const paths = storePaths(root);
    const { stage } = await stageSource(root, acquired, deps, previous.receipt);
    await transact({
      backup: `${stage}.backup`,
      boundary: deps.boundary,
      destroy: async (directory) => destroy(directory, deps),
      source: previous.directory,
      stage,
      state: paths.state,
      target: previous.directory,
      verify: async (directory) => verifySnapshot(directory, deps),
    });
    return inspect(previous.directory, previous.enabled, deps);
  });
}

async function setEnabled(
  root: string,
  name: string,
  enabled: boolean,
  deps: StoreDependencies,
): Promise<Installation> {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    if (previous.enabled === enabled) {
      return previous;
    }
    const paths = storePaths(root);
    const target = join(enabled ? paths.active : paths.disabled, name);
    await transact({
      boundary: deps.boundary,
      destroy: async (directory) => destroy(directory, deps),
      source: previous.directory,
      state: paths.state,
      target,
      verify: async (directory) => verifySnapshot(directory, deps),
    });
    return inspect(target, enabled, deps);
  });
}

async function removeInstallation(
  root: string,
  name: string,
  deps: StoreDependencies,
): Promise<void> {
  validateName(name);
  return withLock(root, async () => {
    const previous = await find(root, name, deps);
    const paths = storePaths(root);
    const reservation = join(paths.state, `remove-${name}`);
    await transact({
      backup: reservation,
      boundary: deps.boundary,
      destroy: async (directory) => destroy(directory, deps),
      source: previous.directory,
      state: paths.state,
      verify: async (directory) => verifySnapshot(directory, deps),
    });
  });
}

type StoreDiagnostics = Readonly<{
  installations: readonly Installation[];
  problems: readonly string[];
}>;

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
  const names = new Set<string>();
  for (const entry of installations) {
    if (names.has(entry.name)) {
      problems.push(`Conflicting active/disabled installation: ${entry.name}`);
    }
    names.add(entry.name);
  }
  return { installations, problems };
}

export type { StoreDependencies, StoreDiagnostics };
export { doctor, install, listInstallations, removeInstallation, setEnabled, update };
