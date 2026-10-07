import { spawn } from "node:child_process";

import { fillShell } from "#src/template.ts";
import type { Rendered } from "#src/template.ts";

// Claude Code's dynamic context injection: each `!`command`` in a command's template is replaced by
// the command's output before the prompt is sent. Commands come only from the template, never from
// arguments. Like OpenCode's own `!` blocks they run outside the agent's permission flow, and only
// when the user invokes the command.
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 100_000;

type RunShell = (command: string, cwd: string, signal: AbortSignal) => Promise<string>;

const shellRunner =
  (shell: string): RunShell =>
  async (command, cwd, signal) =>
    // oxlint-disable-next-line promise/avoid-new -- adapts child_process events, which have no promise API
    new Promise((resolve) => {
      const child = spawn(shell, ["-c", command], {
        cwd,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        resolve(`${output}\n[command failed: ${error.message}]`.trim());
      });
      child.on("close", (code) => {
        const trimmed = output.trimEnd();
        resolve(code === 0 ? trimmed : `${trimmed}\n[exit code ${code}]`.trim());
      });
    });

const injectShell = async (
  rendered: Rendered,
  cwd: string,
  signal: AbortSignal,
  run: RunShell,
): Promise<string> => {
  const outputs = await Promise.all(
    rendered.shell.map(async (command) => run(command, cwd, signal)),
  );
  return fillShell(rendered, outputs);
};

// With injection off, each command is left as visible text instead of running.
const describeInjections = (rendered: Rendered): string =>
  fillShell(
    rendered,
    rendered.shell.map((command) => `[shell injection disabled: ${command}]`),
  );

export type { RunShell };
export { describeInjections, injectShell, shellRunner };
