import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
// oxlint-disable-next-line no-template-curly-in-string -- literal Agent Plugins placeholder
const ROOT = "${PLUGIN_ROOT}";
// oxlint-disable-next-line no-template-curly-in-string -- literal Agent Plugins placeholder
const DATA = "${PLUGIN_DATA}";
// oxlint-disable-next-line no-template-curly-in-string -- unrecognised placeholder that must stay literal
const HOME_PLACEHOLDER = "${HOME}";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

type Tree = Record<string, string | { symlink: string }>;

const makeTempDir = async (prefix = "agent-plugins-"): Promise<string> => {
  const base = await mkdtemp(path.join(tmpdir(), prefix));
  return realpath(base);
};

const trees: string[] = [];
afterEach(async () => {
  await Promise.all(
    trees.splice(0).map(async (base) => rm(base, { force: true, recursive: true })),
  );
});

const makeTree = async (tree: Tree) => {
  const base = await makeTempDir();
  trees.push(base);
  await Promise.all(
    Object.entries(tree).map(async ([file, content]) => {
      const full = path.join(base, file);
      await mkdir(path.dirname(full), { recursive: true });
      await (typeof content === "string"
        ? writeFile(full, content)
        : symlink(content.symlink, full));
    }),
  );
  return base;
};

const skill = (name: string, description = `Does ${name} things.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`;

const manifest = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "demo", ...fields });

const mcp = (servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers, ...extra });

export type { Tree };
export {
  PLUGIN_SCHEMA,
  ROOT,
  DATA,
  HOME_PLACEHOLDER,
  MCP_SCHEMA,
  makeTempDir,
  makeTree,
  skill,
  manifest,
  mcp,
};
