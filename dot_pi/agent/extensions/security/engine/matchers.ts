/**
 * Declarative field matchers for [[tool]] rules (and reusable helpers).
 *
 * A matcher is a plain object whose keys are match keywords. Keys within one
 * matcher AND together; an array value is OR over its entries; `not` nests a
 * matcher whose match inverts the result.
 *
 *   { glob: ["**" + "/.env"], not: { suffix: ".example" } }
 *
 * Keywords: equals, contains, prefix, suffix, glob, domain, re.
 * Unknown keywords never match (fail closed for typos in the rules file).
 */

/** Compile-and-cache RegExp for `re` matchers (patterns come from the user's own rules file). */
const reCache = new Map<string, RegExp>();

function getRe(pattern: string): RegExp | null {
	let re = reCache.get(pattern);
	if (!re) {
		try {
			re = new RegExp(pattern);
		} catch {
			return null;
		}
		if (reCache.size < 256) reCache.set(pattern, re);
	}
	return re;
}

/** Convert a glob to RegExp. "**" + "/" matches zero or more directories, `**` any chars, `*` any non-/ chars, `?` one non-/ char. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*" && glob[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 3;
			} else if (glob[i + 1] === "*") {
				re += ".*";
				i += 2;
			} else {
				re += "[^/]*";
				i += 1;
			}
			continue;
		}
		if (c === "?") {
			re += "[^/]";
			i++;
			continue;
		}
		re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		i++;
	}
	return new RegExp(`^${re}$`);
}

/** Test a value against any of the given regex patterns (OR). Invalid patterns never match. */
export function reMatchAny(patterns: string[], value: string): boolean {
	return patterns.some((p) => {
		const re = getRe(p);
		return re !== null && re.test(value);
	});
}

const globCache = new Map<string, RegExp>();

export function globMatch(glob: string, value: string): boolean {
	let re = globCache.get(glob);
	if (!re) {
		re = globToRegExp(glob);
		if (globCache.size < 256) globCache.set(glob, re);
	}
	return re.test(value);
}

/** Extract hostname for the `domain` matcher; accepts URLs or bare host[:port]. */
function hostnameOf(value: string): string | null {
	try {
		return new URL(value).hostname;
	} catch {
		try {
			return new URL(`https://${value}`).hostname;
		} catch {
			return null;
		}
	}
}

function matchKeyword(keyword: string, spec: unknown, value: unknown): boolean {
	const specs = Array.isArray(spec) ? spec : [spec];
	switch (keyword) {
		case "equals":
			return specs.some((s) => value === s);
		case "contains":
			return typeof value === "string" && specs.some((s) => value.includes(String(s)));
		case "prefix":
			return typeof value === "string" && specs.some((s) => value.startsWith(String(s)));
		case "suffix":
			return typeof value === "string" && specs.some((s) => value.endsWith(String(s)));
		case "glob":
			return typeof value === "string" && specs.some((s) => globMatch(String(s), value));
		case "domain": {
			if (typeof value !== "string") return false;
			const host = hostnameOf(value);
			return (
				host !== null && specs.some((s) => host === String(s) || host.endsWith(`.${String(s)}`))
			);
		}
		case "re":
			return (
				typeof value === "string" &&
				specs.some((s) => {
					const re = getRe(String(s));
					return re !== null && re.test(value);
				})
			);
		default:
			return false;
	}
}

/**
 * Match a value against a matcher object. Multiple keywords AND;
 * `not` nests an inverted matcher.
 */
export function matchValue(matcher: unknown, value: unknown): boolean {
	if (matcher === null || typeof matcher !== "object" || Array.isArray(matcher)) return false;
	for (const [key, spec] of Object.entries(matcher as Record<string, unknown>)) {
		if (key === "not") {
			if (matchValue(spec, value)) return false;
			continue;
		}
		if (!matchKeyword(key, spec, value)) return false;
	}
	return true;
}
