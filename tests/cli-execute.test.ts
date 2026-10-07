import { describe, expect, it, vi } from "vitest";

import { parseArguments } from "#src/cli/arguments.ts";
import { execute } from "#src/cli/execute.ts";
import type { Manager } from "#src/cli/execute.ts";
import type { Installation } from "#src/manager/types.ts";

const entry: Installation = { directory: "/vendor/p", enabled: true, managed: true, name: "p" };
const manager = (): Manager => ({
  doctor: vi.fn(async () => {
    await Promise.resolve();
    return { installations: [entry], problems: [] };
  }),
  enable: vi.fn(async (_name: string, enabled: boolean) => {
    await Promise.resolve();
    return { ...entry, enabled };
  }),
  install: vi.fn(async () => {
    await Promise.resolve();
    return entry;
  }),
  list: vi.fn(async () => {
    await Promise.resolve();
    return [entry];
  }),
  remove: vi.fn(async () => {
    await Promise.resolve();
  }),
  update: vi.fn(async () => {
    await Promise.resolve();
    return entry;
  }),
});

describe("CLI command dispatch", () => {
  it("updates only managed entries when all is requested", async () => {
    const backend = {
      ...manager(),
      list: vi.fn(async () => {
        await Promise.resolve();
        return [entry, { ...entry, managed: false, name: "unmanaged" }];
      }),
    };
    const result = await execute(parseArguments(["update", "--all"]), backend);
    expect(result.entries.map((installation) => installation.name)).toEqual(["p"]);
    expect(backend.update).toHaveBeenCalledExactlyOnceWith("p");
  });
  it("reports doctor state problems using a nonzero status", async () => {
    const backend = {
      ...manager(),
      doctor: vi.fn(async () => {
        await Promise.resolve();
        return { installations: [], problems: ["Interrupted transaction"] };
      }),
    };
    const result = await execute(parseArguments(["doctor"]), backend);
    expect(result.exitCode).toBe(1);
    expect(result.problems).toEqual(["Interrupted transaction"]);
  });
  it("disable uses installation state rather than changing trust", async () => {
    const backend = manager();
    const result = await execute(parseArguments(["disable", "p"]), backend);
    expect(result.entries[0]?.enabled).toBe(false);
    expect(backend.enable).toHaveBeenCalledExactlyOnceWith("p", false);
  });
});
