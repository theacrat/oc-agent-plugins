#!/usr/bin/env bun
// Minimal dependency-free MCP stdio server used to exercise PLUGIN_ROOT, PLUGIN_DATA and cwd.
import { createInterface } from "node:readline";

interface Request {
  readonly id?: unknown;
  readonly method: string;
  readonly params?: { readonly protocolVersion?: string };
}

const METHOD_NOT_FOUND = -32_601;

const tool = {
  description: "Report the server's PLUGIN_ROOT, PLUGIN_DATA, GREETING and working directory",
  inputSchema: { properties: {}, type: "object" },
  name: "whereami",
};

const send = (message: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

const handle = (request: Request) => {
  switch (request.method) {
    case "initialize": {
      send({
        id: request.id,
        result: {
          capabilities: { tools: {} },
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          serverInfo: { name: "hello-where", version: "1.0.0" },
        },
      });
      return;
    }
    case "tools/list": {
      send({ id: request.id, result: { tools: [tool] } });
      return;
    }
    case "tools/call": {
      const { GREETING, PLUGIN_DATA, PLUGIN_ROOT } = process.env;
      const text = JSON.stringify({ GREETING, PLUGIN_DATA, PLUGIN_ROOT, cwd: process.cwd() });
      send({ id: request.id, result: { content: [{ text, type: "text" }] } });
      return;
    }
    default: {
      if (request.id !== undefined) {
        send({ error: { code: METHOD_NOT_FOUND, message: "Method not found" }, id: request.id });
      }
    }
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- trusted JSON-RPC from the MCP client in this example
  handle(JSON.parse(line) as Request);
});
