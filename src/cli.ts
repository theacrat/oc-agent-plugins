#!/usr/bin/env node
import { homedir } from "node:os";

import { errorOutput } from "#src/cli/errors.ts";
import { runCli } from "#src/cli/run.ts";

const main = async () => {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      cwd: process.cwd(),
      env: process.env,
      home: homedir(),
      stderr: (text) => {
        process.stderr.write(`${text}\n`);
      },
      stdout: (text) => {
        process.stdout.write(`${text}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`${errorOutput(process.argv.slice(2), error)}\n`);
    process.exitCode = 1;
  }
};

await main();
