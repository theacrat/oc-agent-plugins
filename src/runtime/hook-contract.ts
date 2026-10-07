import type { Plugin } from "@opencode/plugin";

import type { Report } from "#src/types.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookRegistrationOptions {
  // Must be a per-plugin trust decision, rechecked on every invocation and reload.
  readonly enabled: (hook: PluginHook) => boolean;
  readonly report: Report;
  readonly env?: (hook: PluginHook) => Readonly<Record<string, string>>;
  readonly secretValues?: () => readonly string[];
  // Parent supplies scoped MCP/vendor aliases where registry IDs differ.
  readonly toolName?: (hook: PluginHook, nativeName: string) => string | undefined;
}
interface HooksContext {
  readonly tool: Pick<Plugin.Context["tool"], "hook">;
  readonly session: Pick<Plugin.Context["session"], "hook">;
  readonly location: { readonly directory: string };
}
export type { HookRegistrationOptions, HooksContext };
