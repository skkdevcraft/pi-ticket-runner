import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { registerTicketRunnerCommand } from "./src/command.ts";

/**
 * pi-ticket-runner: execute a folder of local Markdown tickets sequentially,
 * each in its own fresh, persistent Pi session.
 */
export default function ticketRunnerExtension(pi: ExtensionAPI): void {
  registerTicketRunnerCommand(pi, {
    agentDir: getAgentDir(),
    extensionPath: fileURLToPath(import.meta.url),
  });
}
