import type { PluginWorkflow } from "#src/vendor/workflows.ts";

const WORKFLOW_BLOCKER =
  "Dynamic workflow execution unavailable: no process-isolated JavaScript runtime enforcing no filesystem or module loading is configured. Node subprocesses and node:vm do not enforce this contract. A bridge also requires session create/prompt/wait/context and cancellation, bounded agent budget/concurrency, and schema validation (unsupported schemas must fail before spawning). Discovered scripts are export-only and never evaluated.";

const exportWorkflow = (workflow: PluginWorkflow) => ({
  description: workflow.description,
  name: workflow.name,
  source: workflow.source,
  unavailable: WORKFLOW_BLOCKER,
});

export { exportWorkflow, WORKFLOW_BLOCKER };
