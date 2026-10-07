import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Diagnostic } from "#src/types.ts";
import { loadAppMappings, reportBlockedRuntimes } from "#src/vendor/bridges.ts";
import { loadLsp, parseLsp } from "#src/vendor/lsp.ts";

import { makeTree } from "./fixture.ts";

describe("explicit compatibility bridges", () => {
  it("exports supported LSP settings in native V2 shape", async () => {
    const root = await makeTree({
      ".lsp.json": JSON.stringify({
        go: {
          args: ["serve"],
          command: "gopls",
          env: { MODE: "safe" },
          extensionToLanguage: { ".go": "go" },
          initializationOptions: { cache: true },
        },
      }),
    });
    const diagnostics: Diagnostic[] = [];
    const result = await loadLsp(root, undefined, (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    expect(result).toEqual({
      go: {
        command: ["gopls", "serve"],
        env: { MODE: "safe" },
        extensions: [".go"],
        initialization: { cache: true },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("rejects LSP semantics native V2 cannot preserve", () => {
    expect(
      parseLsp({ command: "s", extensionToLanguage: { ".x": "x" }, transport: "socket" }),
    ).toBe("OpenCode LSP export supports stdio only; socket transport cannot be preserved");
    expect(
      parseLsp({ command: "s", extensionToLanguage: { ".x": "x" }, restartOnCrash: false }),
    ).toBe("LSP fields cannot be preserved by native V2 config: restartOnCrash");
  });

  it("resolves app IDs only through explicit endpoint mappings", async () => {
    const root = await makeTree({
      ".app.json": JSON.stringify({ apps: { docs: { id: "asdk_app_docs" } } }),
    });
    const diagnostics: Diagnostic[] = [];
    const report = (diagnostic: Diagnostic) => {
      diagnostics.push(diagnostic);
    };
    expect(await loadAppMappings(root, "./.app.json", {}, report)).toEqual({});
    expect(diagnostics[0]?.severity).toBe("error");
    expect(
      await loadAppMappings(
        root,
        "./.app.json",
        { asdk_app_docs: { url: "https://docs.example.com/mcp" } },
        report,
      ),
    ).toEqual({
      docs: { type: "http", url: "https://docs.example.com/mcp" },
    });
  });

  it("never executes discovered vendor runtime scripts", async () => {
    const root = await makeTree({ "workflows/evil.js": "throw new Error('executed')" });
    const diagnostics: Diagnostic[] = [];
    await reportBlockedRuntimes(root, { channels: [] }, (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    expect(diagnostics.map((diagnostic) => [diagnostic.source, diagnostic.severity])).toEqual([
      ["channels", "error"],
      ["workflows/", "error"],
    ]);
    expect(path.isAbsolute(root)).toBe(true);
  });
});
