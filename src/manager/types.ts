import type { Format, Manifest } from "#src/types.ts";

type Source =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string; readonly subdir?: string };

interface PluginMetadata {
  readonly manifest: Manifest;
  readonly format: Format;
}

interface Receipt {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly format: Format;
  readonly version?: string;
  readonly source: Source;
  readonly revision?: string;
  readonly fingerprint: string;
}

interface Installation {
  readonly name: string;
  readonly directory: string;
  readonly enabled: boolean;
  readonly managed: boolean;
  readonly receipt?: Receipt;
  readonly metadata?: PluginMetadata;
  readonly problem?: string;
}

interface AcquiredSource {
  readonly directory: string;
  readonly source: Source;
  readonly revision?: string;
  readonly dispose: () => Promise<void>;
}

const RECEIPT = ".oc-agent-plugin.json";
const MANAGER_SCHEMA_VERSION = 1;

export type { AcquiredSource, Installation, PluginMetadata, Receipt, Source };
export { MANAGER_SCHEMA_VERSION, RECEIPT };
