import type { HookRegistrationOptions, HooksContext } from "#src/runtime/hook-contract.ts";
import { makeExecutor } from "#src/runtime/hook-executor.ts";
import { registerAfter, registerBefore } from "#src/runtime/hook-registrations.ts";
import type { HookState } from "#src/runtime/hook-registrations.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

const registerSession = async (
  state: HookState,
  registrations: { readonly dispose: () => Promise<void> }[],
): Promise<void> => {
  registrations.push(
    await state.ctx.session.hook("compaction", async (event) => {
      await Promise.all(
        state
          .getCurrentHooks()
          .filter((hook) => hook.phase === "compaction" && state.options.enabled(hook))
          .map(async (hook) => state.execute(hook, event.sessionID, {})),
      );
    }),
  );
  // oxlint-disable-next-line unicorn/prefer-single-call -- Record immediately for partial setup disposal.
  registrations.push(
    await state.ctx.session.hook("context", (event) => {
      const pending = state.contexts.get(event.sessionID) ?? [];
      state.contexts.delete(event.sessionID);
      for (const text of pending) {
        event.system.push({ text, type: "text" });
      }
    }),
  );
};
const registerHooks = async (
  ctx: HooksContext,
  getCurrentHooks: () => readonly PluginHook[],
  options: HookRegistrationOptions,
): Promise<() => Promise<void>> => {
  const base = {
    contexts: new Map<string, string[]>(),
    controller: new AbortController(),
    ctx,
    options,
  };
  const state: HookState = { ...base, execute: makeExecutor(base), getCurrentHooks };
  const registrations: { readonly dispose: () => Promise<void> }[] = [];
  const cleanup = async () => {
    state.controller.abort();
    state.contexts.clear();
    await Promise.all(registrations.map(async (registration) => registration.dispose()));
  };
  try {
    registrations.push(await registerBefore(state));
    // oxlint-disable-next-line unicorn/prefer-single-call -- Record immediately for partial setup disposal.
    registrations.push(await registerAfter(state));
    await registerSession(state, registrations);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
};
export type { HookOutput } from "#src/runtime/hook-output.ts";
export type { HookRegistrationOptions, HooksContext } from "#src/runtime/hook-contract.ts";
export { decodeHookOutput } from "#src/runtime/hook-output.ts";
export {
  nativeInput,
  redactHookContext,
  vendorInput,
  vendorTool,
} from "#src/runtime/hook-tools.ts";
export { registerHooks };
