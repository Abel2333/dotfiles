/**
 * Permission gate: evaluate tool calls against the TOML rules file and
 * enforce deny / ask / log decisions.
 *
 * Policy:
 * - rules file missing        -> allow silently (fail open)
 * - rules file parse failure  -> allow, but notify: a silently dead guard is
 *   worse than a noisy one
 * - engine error              -> allow, notify
 * - deny                      -> block; reason is fed back to the model
 * - ask                       -> user confirmation dialog; without UI the
 *   decision downgrades to deny (a matched rule that cannot be asked is a
 *   security event, not a guard malfunction)
 * - log                       -> allow; audit log + notice
 *
 * The rules file is re-read on every tool call: edits take effect without
 * reloading the extension.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluate, type MatchedRule } from "./engine/evaluate";
import { parseRules, type RulesConfig } from "./engine/rules";
import { writeLog } from "./logger";

const RULES_PATH = join(homedir(), ".pi", "agent", "security-rules.toml");

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Collect the model's most recent explanation text for display in ask dialogs. */
function getModelReasoning(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role !== "assistant") continue;

		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		const textParts: string[] = [];
		for (const block of content) {
			if (block.type === "text" && block.text && block.text.trim()) {
				textParts.push(block.text.trim());
			}
		}
		if (textParts.length > 0) {
			const combined = textParts.join("\n\n");
			return combined.length > 300 ? combined.slice(0, 300) + "..." : combined;
		}

		for (const block of content) {
			if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
				const thinking = block.thinking.trim();
				return thinking.length > 300 ? "(from thinking) " + thinking.slice(0, 300) + "..." : "(from thinking) " + thinking;
			}
		}

		return "(no explanation provided)";
	}

	return "(no explanation provided)";
}

async function handleToolCall(
	toolName: string,
	input: unknown,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	let text: string;
	try {
		text = readFileSync(RULES_PATH, "utf8");
	} catch {
		return undefined; // no rules file -> guard disabled, fail open
	}

	let config: RulesConfig;
	try {
		config = parseRules(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (ctx.hasUI) {
			ctx.ui.notify(`security-gate: rules parse failed, allowed (fix ${RULES_PATH}): ${msg}`, "warning");
		}
		writeLog({
			timestamp: new Date().toISOString(),
			module: "gate",
			action: "allowed",
			tool: toolName,
			reason: `rules parse error: ${msg}`,
			userChoice: "auto-approved",
		});
		return undefined;
	}

	let matched: MatchedRule | null;
	try {
		matched = evaluate(config, toolName, input, { cwd: ctx.cwd, home: homedir() });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (ctx.hasUI) {
			ctx.ui.notify(`security-gate: engine error, allowed: ${msg}`, "warning");
		}
		return undefined;
	}
	if (!matched) return undefined;

	const command = isRecord(input) && typeof input.command === "string" ? input.command : undefined;
	const filePath = isRecord(input) && typeof input.path === "string" ? input.path : undefined;
	const reason = matched.reason || matched.name;
	const baseLog = {
		timestamp: new Date().toISOString(),
		module: "gate" as const,
		tool: toolName,
		command,
		path: filePath,
	};

	if (matched.decision === "log") {
		writeLog({ ...baseLog, action: "allowed", reason: `${matched.name}: ${reason}`, userChoice: "auto-approved" });
		if (ctx.hasUI) {
			ctx.ui.notify(`${reason}: ${(command ?? matched.detail).slice(0, 60)}`, "warning");
		}
		return undefined;
	}

	if (matched.decision === "deny") {
		writeLog({ ...baseLog, action: "blocked", reason: `${matched.name}: ${reason}`, userChoice: "auto-blocked" });
		return { block: true, reason };
	}

	// ask
	if (!ctx.hasUI) {
		writeLog({ ...baseLog, action: "blocked", reason: `${matched.name}: ${reason} (no UI)`, userChoice: "auto-blocked" });
		return { block: true, reason: `${reason} (no UI available for confirmation)` };
	}

	const theme = ctx.ui.theme;
	const confirmMessage = [
		`${theme.bold("Rule:")} ${matched.name}`,
		"",
		...(command ? [`${theme.bold("Command:")} ${command}`, ""] : []),
		...(filePath ? [`${theme.bold("Path:")} ${filePath}`, ""] : []),
		`${theme.bold("Reason:")} ${theme.fg("warning", reason)}`,
		"",
		`${theme.bold("Model said:")} ${getModelReasoning(ctx)}`,
	].join("\n");

	const approved = await ctx.ui.confirm("Allow this action?", confirmMessage);

	writeLog({
		...baseLog,
		action: approved ? "allowed" : "blocked",
		reason: `${matched.name}: ${reason}`,
		userChoice: approved ? "yes" : "no",
	});

	if (!approved) {
		return { block: true, reason: `Blocked by user. Rule: ${matched.name}. ${reason}` };
	}
	return undefined;
}

export function registerGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		return handleToolCall(event.toolName, event.input, ctx);
	});
}
