# ADR 0005: Agent-accessible package management

Agents call `agent_plugins_manage` with a structured action, optional name/source, global scope, ref, subdirectory and update-all flag. The tool uses the same validated manager as the CLI and native command. It does not parse shell text, execute vendor code, grant trust or implicitly rescan runtime components.

The invoking session's location selects project scope and resolves relative sources. Global scope uses the existing OpenCode config-directory resolver. Project overrides are not exposed to agents in this first interface.

OpenCode's tool permission option filters wholly denied tools but does not request approval for allowed invocations. The executor therefore calls the registered native `question` tool and waits for an explicit, exact approval answer before looking up the session or dispatching management. The native question executor enforces its own permission policy and waits for the client's response. Missing question support, denial, dismissal, malformed answers and cancellation fail closed. Each invocation, including reads, requires a fresh approval. Agents cannot bypass the gate with a caller-supplied approval flag.

Input is a closed JSON object and parsed at the tool boundary. Invalid action-specific combinations fail before filesystem mutation. Results contain the existing structured manager output, scope, directory and exit status. Errors use the native manager's safe actionable diagnostic policy. Abort signals are checked before session lookup and before dispatch; an accepted transaction must finish or roll back safely rather than being interrupted halfway through a rename.

Registration belongs to the plugin resource scope and is disposed on setup failure or unload. Independent standards and spec review loops must both be clean at the final HEAD before merge. npm publication is separate.
