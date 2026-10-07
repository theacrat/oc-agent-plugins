import type { Plugin } from "@opencode/plugin";

import type { PluginOutputStyle } from "#src/vendor/output-styles.ts";

interface StyleSource {
  readonly plugin: string;
  readonly styles: readonly PluginOutputStyle[];
  readonly allowSystemReplacement?: boolean;
}
interface StyleSelection {
  readonly plugin: string;
  readonly name: string;
}
interface StyleRuntime {
  readonly select: (sessionID: string, selection: StyleSelection | undefined) => void;
  readonly clearSession: (sessionID: string) => void;
  readonly replace: (sources: readonly StyleSource[]) => void;
  readonly dispose: () => Promise<void>;
}
interface StyleRuntimeOptions {
  // V2 cannot remove only coding instructions. Opt in to replacing the entire assembled system.
  readonly allowSystemReplacement?: boolean;
}

const lookupStyle = (
  sources: readonly StyleSource[],
  selection: StyleSelection,
): PluginOutputStyle | undefined =>
  sources
    .find((source) => source.plugin === selection.plugin)
    ?.styles.find((style) => style.name === selection.name);

const applyStyle = (
  system: { type: "text"; text: string }[],
  style: PluginOutputStyle | undefined,
  options: StyleRuntimeOptions,
): void => {
  if (style === undefined) {
    return;
  }
  if (!style.keepCodingInstructions && options.allowSystemReplacement !== true) {
    throw new Error(
      "V2 cannot isolate coding instructions; select a keep-coding-instructions style or explicitly allow system replacement",
    );
  }
  // V2 exposes the assembled system, not isolated coding instructions. Replacement is explicit.
  if (!style.keepCodingInstructions) {
    system.splice(0);
  }
  system.push({ text: style.content, type: "text" });
};

const validateSelection = (
  sources: readonly StyleSource[],
  selection: StyleSelection | undefined,
  disposed: boolean,
): void => {
  if (disposed) {
    throw new Error("Output style runtime is disposed");
  }
  if (selection !== undefined && lookupStyle(sources, selection) === undefined) {
    throw new Error("Selected output style does not exist");
  }
};

const styleOptions = (
  sources: readonly StyleSource[],
  selected: PluginOutputStyle | undefined,
  defaults: StyleRuntimeOptions,
): StyleRuntimeOptions => {
  const owner =
    selected === undefined ? undefined : sources.find((source) => source.styles.includes(selected));
  return owner?.allowSystemReplacement === undefined
    ? defaults
    : { allowSystemReplacement: owner.allowSystemReplacement };
};

const registerOutputStyles = async (
  ctx: Pick<Plugin.Context, "session">,
  initial: readonly StyleSource[],
  selected: Readonly<Record<string, StyleSelection | undefined>> = {},
  options: StyleRuntimeOptions = {},
): Promise<StyleRuntime> => {
  let sources = structuredClone(initial);
  let disposed = false;
  const sessions = new Map<string, StyleSelection | undefined>();
  const select = (sessionID: string, selection: StyleSelection | undefined) => {
    validateSelection(sources, selection, disposed);
    sessions.set(sessionID, selection === undefined ? undefined : { ...selection });
  };
  for (const [sessionID, selection] of Object.entries(selected)) {
    select(sessionID, selection);
  }
  const registration = await ctx.session.hook("context", (event) => {
    if (disposed || !sessions.has(event.sessionID)) {
      return;
    }
    const forced = sources.flatMap((source) => source.styles).find((style) => style.forceForPlugin);
    const selection = sessions.get(event.sessionID);
    const selectedStyle =
      forced ?? (selection === undefined ? undefined : lookupStyle(sources, selection));
    applyStyle(event.system, selectedStyle, styleOptions(sources, selectedStyle, options));
  });
  return {
    clearSession: (sessionID) => {
      sessions.delete(sessionID);
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      sessions.clear();
      await registration.dispose();
    },
    replace: (next) => {
      sources = structuredClone(next);
    },
    select,
  };
};

export type { StyleRuntime, StyleRuntimeOptions, StyleSelection, StyleSource };
export { registerOutputStyles };
