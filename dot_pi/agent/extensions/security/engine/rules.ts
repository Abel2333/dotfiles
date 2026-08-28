/**
 * TOML rules file loading and validation.
 *
 * The rules file is the security boundary's configuration: a malformed rule
 * must produce a loud error (the caller fails open with a notice), never a
 * silently mis-parsed rule. Validation is therefore strict about field
 * types and decision values.
 *
 * Rule shapes (see security-rules.toml for the full annotated example):
 *
 *   [[bash]]  cmd, subcmd, any, all, args_re, args_glob, redirect_glob,
 *             path_outside, pipe_to, decision, reason, name
 *   [[tool]]  tool, where, decision, reason, name
 */

import { parse } from "../vendor/smol-toml/index.js";

export type Decision = "deny" | "ask" | "log";

export interface BashRule {
	name: string;
	cmd?: string[];
	subcmd?: string[];
	/** OR: at least one token condition matches. */
	any?: string[][];
	/** AND of OR-groups: every group has at least one matching token. */
	all?: string[][];
	argsRe?: string[];
	argsGlob?: string[];
	redirectGlob?: string[];
	pathOutside?: string[];
	pipeTo?: string[];
	decision: Decision;
	reason: string;
}

export interface ToolRule {
	name: string;
	tool: string[];
	where?: Record<string, unknown>;
	decision: Decision;
	reason: string;
}

export interface RulesConfig {
	bash: BashRule[];
	tool: ToolRule[];
}

export class RulesConfigError extends Error {}

function asStringArray(value: unknown, field: string, ruleLabel: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
	throw new RulesConfigError(`${ruleLabel}: field "${field}" must be a string or array of strings`);
}

/** Normalize any/all condition groups: elements may be strings or string arrays. */
function asCondGroups(value: unknown, field: string, ruleLabel: string): string[][] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new RulesConfigError(`${ruleLabel}: field "${field}" must be an array`);
	}
	return value.map((entry, i) => {
		if (typeof entry === "string") return [entry];
		if (Array.isArray(entry) && entry.every((v) => typeof v === "string")) return entry as string[];
		throw new RulesConfigError(`${ruleLabel}: field "${field}" entry ${i} must be a string or array of strings`);
	});
}

function asDecision(value: unknown, ruleLabel: string): Decision {
	if (value === "deny" || value === "ask" || value === "log") return value;
	throw new RulesConfigError(`${ruleLabel}: decision must be "deny", "ask", or "log" (got ${JSON.stringify(value)})`);
}

function asReason(value: unknown, ruleLabel: string): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	throw new RulesConfigError(`${ruleLabel}: reason must be a string`);
}

function ruleLabel(kind: string, index: number, name: unknown): string {
	return typeof name === "string" && name ? `${kind} rule "${name}"` : `${kind} rule #${index}`;
}

function parseBashRule(raw: unknown, index: number): BashRule {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new RulesConfigError(`bash rule #${index}: must be a table`);
	}
	const r = raw as Record<string, unknown>;
	const label = ruleLabel("bash", index, r.name);
	return {
		name: typeof r.name === "string" ? r.name : `bash#${index}`,
		cmd: asStringArray(r.cmd, "cmd", label),
		subcmd: asStringArray(r.subcmd, "subcmd", label),
		any: asCondGroups(r.any, "any", label),
		all: asCondGroups(r.all, "all", label),
		argsRe: asStringArray(r.args_re, "args_re", label),
		argsGlob: asStringArray(r.args_glob, "args_glob", label),
		redirectGlob: asStringArray(r.redirect_glob, "redirect_glob", label),
		pathOutside: asStringArray(r.path_outside, "path_outside", label),
		pipeTo: asStringArray(r.pipe_to, "pipe_to", label),
		decision: asDecision(r.decision, label),
		reason: asReason(r.reason, label),
	};
}

function parseToolRule(raw: unknown, index: number): ToolRule {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new RulesConfigError(`tool rule #${index}: must be a table`);
	}
	const r = raw as Record<string, unknown>;
	const label = ruleLabel("tool", index, r.name);
	if (r.where !== undefined && (r.where === null || typeof r.where !== "object" || Array.isArray(r.where))) {
		throw new RulesConfigError(`${label}: "where" must be a table`);
	}
	const tool = asStringArray(r.tool, "tool", label);
	if (!tool) throw new RulesConfigError(`${label}: field "tool" is required`);
	return {
		name: typeof r.name === "string" ? r.name : `tool#${index}`,
		tool,
		where: r.where as Record<string, unknown> | undefined,
		decision: asDecision(r.decision, label),
		reason: asReason(r.reason, label),
	};
}

/** Parse and validate rules TOML text. Throws RulesConfigError on invalid content. */
export function parseRules(text: string): RulesConfig {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (err) {
		throw new RulesConfigError(`TOML parse error: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		throw new RulesConfigError("rules file must be a TOML document");
	}
	const root = doc as Record<string, unknown>;
	const bash = root.bash === undefined ? [] : root.bash;
	const tool = root.tool === undefined ? [] : root.tool;
	if (!Array.isArray(bash)) throw new RulesConfigError('"bash" must be an array of tables ([[bash]])');
	if (!Array.isArray(tool)) throw new RulesConfigError('"tool" must be an array of tables ([[tool]])');
	return {
		bash: bash.map(parseBashRule),
		tool: tool.map(parseToolRule),
	};
}
