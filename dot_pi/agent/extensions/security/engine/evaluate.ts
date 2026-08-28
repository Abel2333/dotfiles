/**
 * Rule evaluation: match a tool call against the parsed rules config.
 *
 * Order: for the bash tool, every [[bash]] rule is tried against every
 * command segment first (first hit wins); [[tool]] rules run afterwards
 * for all tools (bash included).
 *
 * Matchers never throw: parse failures degrade to "no match" so a broken
 * command line cannot lock the user out (and cannot be exploited to
 * bypass rules either — a malformed dangerous command is handled by the
 * fail-open-with-notice policy at the call site).
 */

import path from "node:path";
import { argvVariants, type Argv } from "./argv";
import { globMatch, matchValue, reMatchAny } from "./matchers";
import type { BashRule, Decision, RulesConfig, ToolRule } from "./rules";
import { tokenize, type Segment } from "./tokenize";

export interface EvalOptions {
	cwd: string;
	home: string;
}

export interface MatchedRule {
	kind: "bash" | "tool";
	name: string;
	decision: Decision;
	reason: string;
	/** Human-readable detail for logs/notices (e.g. the matched segment). */
	detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.posix.join(home, p.slice(2));
	if (p === "$HOME") return home;
	if (p.startsWith("$HOME/")) return path.posix.join(home, p.slice(6));
	return p;
}

function resolvePath(p: string, opts: EvalOptions): string {
	const expanded = expandHome(p, opts.home);
	return path.posix.isAbsolute(expanded)
		? path.posix.normalize(expanded)
		: path.posix.resolve(opts.cwd, expanded);
}

/** Condition token semantics: "--foo" long flag, "-f" short flag (cluster-expanded), else positional. */
function tokenMatches(cond: string, argv: Argv): boolean {
	if (cond.startsWith("--")) return argv.flags.has(cond);
	if (/^-[a-zA-Z]$/.test(cond)) return argv.flags.has(cond);
	return argv.positionals.includes(cond);
}

function matchBashRuleOnSegment(
	rule: BashRule,
	segment: Segment,
	allSegments: Segment[],
	opts: EvalOptions,
): Argv | null {
	for (const argv of argvVariants(segment)) {
		if (rule.cmd && !rule.cmd.includes(argv.cmd)) continue;
		if (rule.subcmd && !rule.subcmd.some((s) => argv.positionals.includes(s))) continue;
		if (rule.all && !rule.all.every((group) => group.some((cond) => tokenMatches(cond, argv)))) {
			continue;
		}
		if (rule.any && !rule.any.some((group) => group.some((cond) => tokenMatches(cond, argv)))) {
			continue;
		}
		if (rule.argsRe && !argv.positionals.some((p) => reMatchAny(rule.argsRe as string[], p))) {
			continue;
		}
		if (
			rule.argsGlob &&
			!argv.positionals.some(
				(p) =>
					rule.argsGlob?.some((g) => globMatch(g, p) || globMatch(g, resolvePath(p, opts))),
			)
		) {
			continue;
		}
		if (
			rule.redirectGlob &&
			!segment.redirectTargets.some(
				(t) =>
					rule.redirectGlob?.some((g) => globMatch(g, t) || globMatch(g, resolvePath(t, opts))),
			)
		) {
			continue;
		}
		if (rule.pathOutside) {
			const whitelist = rule.pathOutside.map((w) => resolvePath(w, opts));
			const hasOutside = argv.positionals.some((p) => {
				const resolved = resolvePath(p, opts);
				return !whitelist.some((w) => resolved === w || resolved.startsWith(w + "/"));
			});
			if (!hasOutside) continue;
		}
		if (rule.pipeTo) {
			const piped = allSegments.some(
				(other) =>
					other !== segment &&
					argvVariants(other).some((a) => rule.pipeTo?.includes(a.cmd)),
			);
			if (!piped) continue;
		}
		return argv;
	}
	return null;
}

function matchToolRule(rule: ToolRule, toolName: string, input: unknown): boolean {
	if (!rule.tool.includes(toolName)) return false;
	if (!rule.where) return true;
	if (!isRecord(input)) return false;
	return Object.entries(rule.where).every(([field, matcher]) => matchValue(matcher, input[field]));
}

/** Evaluate a tool call against the rules. Returns the first matching rule, or null. */
export function evaluate(
	config: RulesConfig,
	toolName: string,
	input: unknown,
	opts: EvalOptions,
): MatchedRule | null {
	if (toolName === "bash" && isRecord(input) && typeof input.command === "string") {
		const segments = tokenize(input.command);
		for (const rule of config.bash) {
			for (const segment of segments) {
				if (matchBashRuleOnSegment(rule, segment, segments, opts) !== null) {
					return {
						kind: "bash",
						name: rule.name,
						decision: rule.decision,
						reason: rule.reason,
						detail: segment.tokens.join(" "),
					};
				}
			}
		}
	}

	for (const rule of config.tool) {
		if (matchToolRule(rule, toolName, input)) {
			return {
				kind: "tool",
				name: rule.name,
				decision: rule.decision,
				reason: rule.reason,
				detail: toolName,
			};
		}
	}

	return null;
}
