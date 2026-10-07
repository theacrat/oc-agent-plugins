import { describe, expect, it } from "vitest";

import { describeInjections, injectShell, shellRunner } from "#src/shell.ts";
import { renderCommand } from "#src/template.ts";

import { makeTree } from "./fixture.ts";

const run = shellRunner("/bin/sh");
const signal = () => AbortSignal.timeout(10_000);
const claude = (template: string, names: readonly string[] = []) => ({
  arguments: names,
  name: "x",
  syntax: "claude" as const,
  template,
});
const expand = async (template: string, input: string, cwd = "/") =>
  injectShell(renderCommand(claude(template), input), cwd, signal(), run);

describe("shell injection", () => {
  it("replaces each !`cmd` with its output, run in the given directory", async () => {
    const dir = await makeTree({ "marker.txt": "hello" });
    expect(await expand("Status: !`cat marker.txt`\nBranch: !`printf main`", "", dir)).toBe(
      "Status: hello\nBranch: main",
    );
  });

  it("reports failures inline instead of throwing", async () => {
    expect(await expand("x !`echo oops >&2; exit 3` y", "")).toBe("x oops\n[exit code 3] y");
  });

  it("doesn't rescan command output for more injections", async () => {
    const dir = await makeTree({ "inject.txt": "!`echo nested`" });
    expect(await expand("Got: !`cat inject.txt`", "", dir)).toBe("Got: !`echo nested`");
  });

  it("never runs injections that arrive through arguments", async () => {
    expect(await expand("Say $ARGUMENTS", "hi !`echo pwned`")).toBe("Say hi !`echo pwned`");
    expect(await expand("Say $0", "'!`echo pwned`'")).toBe("Say !`echo pwned`");
  });

  it("can't be tricked by arguments that look like internal markers", async () => {
    expect(await expand("A !`printf one` B $ARGUMENTS", "\u00000\u0000")).toBe("A one B 0");
  });

  it("passes the injection command through without substituting arguments into it", () => {
    const rendered = renderCommand(claude("Branch !`git log -$1` for $0"), "x y");
    expect(rendered).toEqual({ shell: ["git log -$1"], text: "Branch \u00000\u0000 for x" });
  });

  it("shows disabled injections as visible text", () => {
    const rendered = renderCommand(claude("Diff: !`git diff HEAD`"), "");
    expect(describeInjections(rendered)).toBe("Diff: [shell injection disabled: git diff HEAD]");
  });
});
