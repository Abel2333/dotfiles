/**
 * Security Extension
 *
 *   1. Permission gate    - TOML-rule-driven interception of tool calls
 *                           (deny/ask/log), see gate.ts and
 *                           ~/.pi/agent/security-rules.toml
 *   2. Session guard      - confirm before clearing or switching sessions,
 *                           see session-guard.ts
 *
 * Commands:
 *   /security-log view [N]  - show recent log entries (default: 20)
 *   /security-log stats     - show summary statistics
 *   /security-log clear     - clear all logs (requires confirmation)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate";
import { registerSessionGuards } from "./session-guard";
import { clearLogs, getLogStats, readLogs } from "./logger";

export default function (pi: ExtensionAPI) {
	registerGate(pi);
	registerSessionGuards(pi);

	pi.registerCommand("security-log", {
		description: "View, clear, or get stats for the security log",
		async handler(args, ctx) {
			const parts = (args || "").trim().split(/\s+/);
			const subcmd = parts[0] || "view";

			if (subcmd === "clear") {
				const confirmed = await ctx.ui.confirm(
					"Clear security log?",
					"This will permanently delete all security log entries.",
				);
				if (confirmed) {
					clearLogs();
					ctx.ui.notify("Security log cleared.", "info");
				} else {
					ctx.ui.notify("Clear cancelled.", "info");
				}
				return;
			}

			if (subcmd === "stats") {
				const stats = getLogStats();
				const lines = [
					`Total entries: ${stats.total}`,
					"",
					"By module:",
					...Object.entries(stats.byModule).map(([k, v]) => `  ${k}: ${v}`),
					"",
					"By action:",
					...Object.entries(stats.byAction).map(([k, v]) => `  ${k}: ${v}`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Default: view
			const count = parseInt(parts[1], 10) || 20;
			const logs = readLogs(count);
			if (logs.length === 0) {
				ctx.ui.notify("No security log entries.", "info");
				return;
			}

			const lines = logs.map((e) => {
				const ts = e.timestamp.slice(0, 19).replace("T", " ");
				const icon = e.action === "blocked" ? "BLOCK" : e.action === "allowed" ? "ALLOW" : "CANCEL";
				const detail = e.command
					? e.command.slice(0, 50)
					: e.path
						? e.path.slice(0, 50)
						: e.reason || "";
				return `[${ts}] ${icon} [${e.module}] ${detail}`;
			});

			ctx.ui.notify(`Security log (last ${logs.length}):\n${lines.join("\n")}`, "info");
		},
	});
}
