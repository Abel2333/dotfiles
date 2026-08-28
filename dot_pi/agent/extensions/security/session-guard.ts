/**
 * Destructive session guard: confirm before clearing or switching sessions.
 *
 * - session_before_switch("new"): always confirm (wiped messages)
 * - session_before_switch("resume"): confirm when there is unacknowledged
 *   user input (messages after the last assistant reply)
 * - session_before_fork: confirm fork creation
 *
 * Unchanged behavior, split out of the former monolithic index.ts.
 */

import type {
	ExtensionAPI,
	SessionBeforeSwitchEvent,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { writeLog } from "./logger";

export function registerSessionGuards(pi: ExtensionAPI): void {
	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		if (!ctx.hasUI) return;

		if (event.reason === "new") {
			const confirmed = await ctx.ui.confirm(
				"Clear session?",
				"This will delete all messages in the current session.",
			);

			if (!confirmed) {
				writeLog({
					timestamp: new Date().toISOString(),
					module: "destructive",
					action: "cancelled",
					reason: "new session cancelled",
					userChoice: "no",
				});
				ctx.ui.notify("Clear cancelled", "info");
				return { cancel: true };
			}

			writeLog({
				timestamp: new Date().toISOString(),
				module: "destructive",
				action: "allowed",
				reason: "new session confirmed",
				userChoice: "yes",
			});
			return;
		}

		// reason === "resume" - check for unsaved work since last assistant response
		const entries = ctx.sessionManager.getEntries();

		let lastAssistantIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message.role === "assistant") {
				lastAssistantIndex = i;
				break;
			}
		}

		// If no assistant has ever responded, all user messages are "unsaved"
		const hasUnsavedWork = lastAssistantIndex === -1
			? entries.some((e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user")
			: entries.slice(lastAssistantIndex + 1).some(
					(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
				);

		if (hasUnsavedWork) {
			const confirmed = await ctx.ui.confirm(
				"Switch session?",
				"You have unacknowledged messages in the current session. Switch anyway?",
			);

			if (!confirmed) {
				writeLog({
					timestamp: new Date().toISOString(),
					module: "destructive",
					action: "cancelled",
					reason: "session switch cancelled (unsaved work)",
					userChoice: "no",
				});
				ctx.ui.notify("Switch cancelled", "info");
				return { cancel: true };
			}

			writeLog({
				timestamp: new Date().toISOString(),
				module: "destructive",
				action: "allowed",
				reason: "session switch with unsaved work",
				userChoice: "yes",
			});
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select(
			`Fork from entry ${event.entryId.slice(0, 8)}?`,
			["No, stay in current session", "Yes, create fork"],
		);

		if (choice !== "Yes, create fork") {
			writeLog({
				timestamp: new Date().toISOString(),
				module: "destructive",
				action: "cancelled",
				reason: "fork cancelled",
				userChoice: "no",
			});
			ctx.ui.notify("Fork cancelled", "info");
			return { cancel: true };
		}

		writeLog({
			timestamp: new Date().toISOString(),
			module: "destructive",
			action: "allowed",
			reason: `fork from ${event.entryId.slice(0, 8)}`,
			userChoice: "yes",
		});
	});
}
