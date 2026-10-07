import { describe, expect, it } from "vitest";

import { configDirectory, parseOptions } from "#src/options.ts";

describe("native OpenCode config directory", () => {
  it("uses OPENCODE_CONFIG_DIR directly before XDG_CONFIG_HOME", () => {
    const directory = configDirectory("/home/u", {
      OPENCODE_CONFIG_DIR: "/custom/opencode",
      XDG_CONFIG_HOME: "/xdg",
    });
    expect(directory).toBe("/custom/opencode");
    const options = parseOptions(
      {
        configDirectory: directory,
        dataHome: "/data",
        home: "/home/u",
        project: "/project",
        raw: {},
      },
      (entry) => {
        throw new Error(entry.message);
      },
    );
    expect(options.searchPaths).toContain("/custom/opencode/agent-plugins");
    expect(options.searchPaths).not.toContain("/custom/opencode/opencode/agent-plugins");
  });

  it("falls back to XDG and then the normal user config directory", () => {
    expect(configDirectory("/home/u", { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode");
    expect(configDirectory("/home/u", {})).toBe("/home/u/.config/opencode");
  });

  it.each([
    [{ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "/xdg" }, "/xdg/opencode"],
    [{ XDG_CONFIG_HOME: "" }, "/home/u/.config/opencode"],
    [{ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "/home/u/.config/opencode"],
    [{ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "" }, "/custom"],
  ])("treats empty overrides as unset: %j", (env, expected) => {
    const directory = configDirectory("/home/u", env);
    expect(directory).toBe(expected);
    const options = parseOptions(
      {
        configDirectory: directory,
        dataHome: "/data",
        home: "/home/u",
        project: "/project",
        raw: {},
      },
      (entry) => {
        throw new Error(entry.message);
      },
    );
    expect(options.searchPaths[1]).toBe(`${expected}/agent-plugins`);
  });
});
