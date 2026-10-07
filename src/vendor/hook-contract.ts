import type { Report } from "#src/types.ts";

type HookPhase = "before" | "after" | "failure" | "compaction";
interface PluginHook {
  readonly root: string;
  readonly format: "claude" | "codex" | "cursor";
  readonly event: string;
  readonly phase: HookPhase;
  readonly source: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly matcher?: string;
  readonly timeout: number;
  readonly failClosed: boolean;
}
interface HookLoadOptions {
  readonly enabled?: boolean;
  readonly report: Report;
}

const phases: Record<string, HookPhase> = {
  PostToolUse: "after",
  PostToolUseFailure: "failure",
  PreCompact: "compaction",
  PreToolUse: "before",
  afterFileEdit: "after",
  afterShellExecution: "after",
  beforeShellExecution: "before",
  postToolUse: "after",
  postToolUseFailure: "failure",
  preCompact: "compaction",
  preToolUse: "before",
};
const blockers: Record<string, string> = {
  PermissionRequest: "permission.evaluate lacks the vendor tool input and pending-request boundary",
  SessionEnd:
    "public removal events do not cover client close, archive and idle termination boundaries",
  SessionStart: "public creation events do not cover resume, clear and compaction-start boundaries",
  Stop: "no public before-turn-completion interception or vendor continuation boundary",
  UserPromptSubmit:
    "prompt admission has no typed rejection API; throwing is not a supported vendor rejection contract",
  beforeMCPExecution:
    "tool hooks lack MCP connection URL/launch metadata required by this policy contract",
  beforeReadFile:
    "execute.before lacks full file content and prompt attachments required by Cursor file access policy",
  beforeSubmitPrompt: "prompt admission has no typed rejection API",
  sessionEnd: "public removal events do not cover the Cursor editor session boundary",
  sessionStart: "public creation events do not cover the Cursor editor session boundary",
  stop: "no public before-turn-completion interception or bounded vendor follow-up loop",
};

const hookMatcher = (hook: Pick<PluginHook, "format" | "matcher">, value: string): boolean => {
  const pattern = hook.matcher;
  if (!pattern || pattern === "*") {
    return true;
  }
  if (hook.format === "claude" && /^[\w\- ,|]+$/u.test(pattern)) {
    return pattern.split(/[|,]/u).some((entry) => entry.trim() === value);
  }
  return new RegExp(pattern, "u").test(value);
};

export type { HookLoadOptions, HookPhase, PluginHook };
export { blockers, hookMatcher, phases };
