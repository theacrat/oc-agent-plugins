import { mkdir } from "node:fs/promises";

import { beforeAll } from "vitest";

beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true });
});
