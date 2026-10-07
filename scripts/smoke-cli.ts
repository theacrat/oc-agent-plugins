import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from "#src/json.ts";

// Node provides the promisify overload for execFile's callback API.
// oxlint-disable-next-line typescript/strict-void-return
const executeFile = promisify(execFile);
const temporary = await mkdtemp(path.join(tmpdir(), "agent-cli-smoke-"));
const root = await realpath(temporary);
const project = path.join(root, "project with spaces");
await mkdir(project);
const cli = path.resolve("dist/cli.js");
const invoke = async (...args: string[]) => {
  const { stdout } = await executeFile("node", [cli, ...args, "--project", project, "--json"]);
  const output: unknown = JSON.parse(stdout);
  if (!isRecord(output) || output["exitCode"] !== 0) {
    throw new Error("CLI failed");
  }
  return output;
};
const activation = (output: Readonly<Record<string, unknown>>, enabled: boolean) => {
  const { entries } = output;
  if (!Array.isArray(entries) || !isRecord(entries[0]) || entries[0]["enabled"] !== enabled) {
    throw new Error("Unexpected activation state");
  }
};
try {
  await invoke("install", path.resolve("examples/hello"));
  activation(await invoke("disable", "hello"), false);
  activation(await invoke("update", "hello"), false);
  activation(await invoke("enable", "hello"), true);
  await invoke("doctor");
  await invoke("uninstall", "hello");
  const listed = await invoke("list");
  const { entries } = listed;
  if (!Array.isArray(entries) || entries.length > 0) {
    throw new Error("Uninstall failed");
  }
  console.log("Bundled Node CLI lifecycle passed");
} finally {
  await rm(root, { force: true, recursive: true });
}
