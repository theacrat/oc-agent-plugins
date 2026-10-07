// The manager hashes snapshots with Node's standard SHA-256 implementation.
// eslint-disable-next-line import/no-nodejs-modules
import { createHash } from "node:crypto";

import { directoryFiles } from "#src/manager/snapshot.ts";

const fingerprintDirectory = async (directory: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const file of await directoryFiles(directory, false)) {
    hash.update(JSON.stringify([file.kind, file.path, file.executable, file.content.length]));
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
};

export { fingerprintDirectory };
