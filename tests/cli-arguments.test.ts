import { describe, expect, it } from "vitest";

import { parseArguments } from "#src/cli/arguments.ts";
import { locations } from "#src/cli/locations.ts";

describe("CLI interface", () => {
  it("parses install and remote selection without granting execution trust", () => {
    expect(
      parseArguments([
        "install",
        "cloudflare/skills",
        "--global",
        "--ref",
        "main",
        "--subdir",
        "plugins/review",
        "--json",
      ]),
    ).toEqual({
      all: false,
      command: "install",
      global: true,
      json: true,
      ref: "main",
      subdir: "plugins/review",
      target: "cloudflare/skills",
    });
  });
  it.each(
    [
      ["install"],
      ["update"],
      ["update", "p", "--all"],
      ["list", "p"],
      ["list", "--all"],
      ["install", "p", "--global", "--project", "/p"],
      ["wat"],
      ["remove", "../plugin"],
      ["list", "--force"],
    ].map((args) => [args] as const),
  )("rejects invalid invocation %j", (args) => {
    expect(() => parseArguments(args)).toThrow();
  });
  it("supports update all, removal alias and plain help", () => {
    expect(parseArguments(["update", "--all"]).all).toBe(true);
    expect(parseArguments(["remove", "p"]).command).toBe("uninstall");
    expect(parseArguments([]).command).toBe("help");
  });
  it("resolves project and native config locations", () => {
    expect(
      locations(parseArguments(["list", "--project", "../other"]), "/work/project", "/home/u", {}),
    ).toEqual({
      project: "/work/other",
      root: "/work/other/.opencode/agent-plugins",
      scope: "project",
    });
    expect(
      locations(parseArguments(["list", "--global"]), "/work", "/home/u", {
        OPENCODE_CONFIG_DIR: "/config",
      }).root,
    ).toBe("/config/agent-plugins");
  });
});
