import type { JsonRecord } from "#src/json.ts";
import { WORKFLOW_BLOCKER } from "#src/runtime/workflows.ts";
import type { Report } from "#src/types.ts";
import { loadChannels } from "#src/vendor/channels.ts";
import { loadMonitors } from "#src/vendor/monitors.ts";
import { loadThemes, THEME_BLOCKER } from "#src/vendor/themes.ts";
import { loadWorkflows } from "#src/vendor/workflows.ts";

const loadRuntimeComponents = async (root: string, raw: JsonRecord, report: Report) => {
  const [monitors, workflows, themes] = await Promise.all([
    loadMonitors(root, raw, report),
    loadWorkflows(root, raw, report),
    loadThemes(root, raw, report),
  ]);
  for (const workflow of workflows) {
    report({ message: WORKFLOW_BLOCKER, severity: "warning", source: workflow.path });
  }
  for (const theme of themes) {
    report({ message: THEME_BLOCKER, severity: "warning", source: theme.path });
  }
  return { channels: loadChannels(raw, report), monitors, themes, workflows };
};

export { loadRuntimeComponents };
