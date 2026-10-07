import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Manager } from "#src/cli/execute.ts";
import { fingerprintDirectory } from "#src/manager/fingerprint.ts";
import { readMetadata } from "#src/manager/metadata.ts";
import { snapshotDirectory } from "#src/manager/snapshot.ts";
import { acquireSource, parseSource } from "#src/manager/source.ts";
import {
  doctor,
  install,
  listInstallations,
  removeInstallation,
  setEnabled,
  update,
} from "#src/manager/store.ts";
import type { AcquiredSource, Installation, Source } from "#src/manager/types.ts";

const dependencies = { fingerprintDirectory, readMetadata, snapshotDirectory };

const withSource = async <Result>(
  source: Source,
  run: (acquired: AcquiredSource) => Promise<Result>,
): Promise<Result> => {
  const scratch = await mkdtemp(path.join(tmpdir(), "oc-agent-plugins-acquire-"));
  try {
    const acquired = await acquireSource(source, scratch);
    try {
      return await run(acquired);
    } finally {
      await acquired.dispose();
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};

const installationForUpdate = async (root: string, name: string): Promise<Installation> => {
  const entries = await listInstallations(root, dependencies);
  const matches = entries.filter((entry) => entry.name === name);
  const [entry] = matches;
  if (
    matches.length !== 1 ||
    entry?.receipt === undefined ||
    !entry.managed ||
    entry.problem !== undefined
  ) {
    throw new Error(
      `Cannot update ${name}: missing, conflicting, edited or unmanaged installation`,
    );
  }
  return entry;
};

const createManager = (root: string, cwd: string): Manager => ({
  doctor: async () => doctor(root, dependencies),
  enable: async (name, enabled) => setEnabled(root, name, enabled, dependencies),
  install: async (input, args) => {
    const source = await parseSource(input, {
      cwd,
      ...(args.ref === undefined ? {} : { ref: args.ref }),
      ...(args.subdir === undefined ? {} : { subdir: args.subdir }),
    });
    return withSource(source, async (acquired) => install(root, acquired, dependencies));
  },
  list: async () => listInstallations(root, dependencies),
  remove: async (name) => removeInstallation(root, name, dependencies),
  update: async (name) => {
    const previous = await installationForUpdate(root, name);
    const { receipt } = previous;
    if (receipt === undefined) {
      throw new Error("Missing managed receipt");
    }
    return withSource(receipt.source, async (acquired) =>
      update(root, name, acquired, dependencies, receipt),
    );
  },
});

export { createManager };
