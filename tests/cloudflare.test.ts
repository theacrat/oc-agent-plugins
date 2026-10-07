import { describe, expect, it } from "vitest";

import { loadAll } from "#src/loader.ts";
import { toServerConfigs } from "#src/opencode.ts";

import { makeTree } from "./fixture.ts";

// Real-world plugin: https://github.com/cloudflare/skills. Clone it and point CLOUDFLARE_SKILLS at the checkout.
const checkout = process.env["CLOUDFLARE_SKILLS"];

describe.skipIf(checkout === undefined)("cloudflare/skills", () => {
  it("loads every skill and the remote MCP server without diagnostics", async () => {
    const result = await loadAll([checkout ?? ""], {
      dataRoot: await makeTree({}),
    });
    const [plugin] = result.plugins;
    expect(result.diagnostics).toEqual([]);
    expect(plugin?.manifest.name).toBe("cloudflare");
    expect(plugin?.skills.length).toBeGreaterThanOrEqual(16);
    expect(plugin === undefined ? [] : toServerConfigs(plugin)).toEqual([
      [
        "cloudflare-cloudflare",
        { headers: {}, type: "remote", url: "https://mcp.cloudflare.com/mcp" },
      ],
    ]);
  });
});
