/**
 * Argv-level parsing of tokenized command segments.
 *
 * Produces a structural view of a command: resolved command name (basename),
 * expanded short-flag clusters (-rf -> {-r, -f}), long flags, and positional
 * arguments. Tokens after `--` are always positional. Leading env
 * assignments (FOO=bar) are skipped.
 *
 * argvVariants() additionally unwraps sudo/doas prefixes so that
 * `sudo rm -rf x` still matches rules written for `rm`.
 */

import type { Segment } from "./tokenize";

export interface Argv {
	/** Basename of the command token (e.g. "/usr/bin/rm" -> "rm"). */
	cmd: string;
	/** First positional argument, if any. */
	subcmd: string | undefined;
	/** Flags as a set: long flags verbatim ("--force"), short flags expanded ("-r", "-f"). */
	flags: Set<string>;
	/** Non-option arguments in order (includes everything after `--`). */
	positionals: string[];
}

/** sudo/doas flags that consume the following token as their value. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-t"]);

export function parseArgv(tokens: string[]): Argv | null {
	const rest = [...tokens];
	while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift();
	if (rest.length === 0) return null;

	const cmdToken = rest.shift() as string;
	const cmd = cmdToken.split("/").pop() || cmdToken;

	const flags = new Set<string>();
	const positionals: string[] = [];
	let noMoreFlags = false;

	for (const t of rest) {
		if (!noMoreFlags && t === "--") {
			noMoreFlags = true;
			continue;
		}
		if (!noMoreFlags && t.startsWith("--")) {
			flags.add(t.split("=")[0]);
			continue;
		}
		if (!noMoreFlags && t.startsWith("-") && t.length > 1) {
			if (/^-[0-9]/.test(t)) {
				// Numeric dash args (kill -9, head -5) quack like values, not flags.
				positionals.push(t);
				continue;
			}
			// Short cluster, possibly with attached value (-rf, -n5, -o=x):
			// expand leading letters, stop at the first non-letter.
			for (const ch of t.slice(1).split("=")[0]) {
				if (/[a-zA-Z]/.test(ch)) flags.add("-" + ch);
				else break;
			}
			continue;
		}
		positionals.push(t);
	}

	return { cmd, subcmd: positionals[0], flags, positionals };
}

/**
 * All argv interpretations of a segment: the segment itself plus an
 * unwrapped view when it is prefixed by sudo/doas.
 */
export function argvVariants(segment: Segment): Argv[] {
	const primary = parseArgv(segment.tokens);
	if (!primary) return [];

	const variants = [primary];
	if (primary.cmd === "sudo" || primary.cmd === "doas") {
		const rest = [...segment.tokens];
		rest.shift(); // the wrapper itself
		while (rest.length > 0 && rest[0].startsWith("-")) {
			const t = rest.shift() as string;
			if (WRAPPER_VALUE_FLAGS.has(t)) rest.shift();
		}
		const inner = parseArgv(rest);
		if (inner) variants.push(inner);
	}
	return variants;
}
