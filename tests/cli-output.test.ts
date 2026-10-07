import { describe, expect, it } from "vitest";

import { infoOutput, listOutput } from "#src/cli/output.ts";
import type { Installation } from "#src/manager/types.ts";

describe("CLI output", () => {
  const entry: Installation = {
    directory: "/project/.opencode/agent-plugins/p",
    enabled: true,
    managed: false,
    name: "p",
  };
  it("makes scope and ownership visible", () => {
    expect(listOutput([entry], "/project/.opencode/agent-plugins")).toBe(
      "/project/.opencode/agent-plugins\np  enabled  unmanaged  unversioned",
    );
    expect(infoOutput(entry)).toContain("Source: not managed by this CLI");
  });
  it("prints a clear empty inventory", () => {
    expect(listOutput([], "/vendor")).toBe("/vendor\nNo plugins installed.");
  });
});
