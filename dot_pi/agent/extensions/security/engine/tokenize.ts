/**
 * POSIX-ish shell tokenizer for the security gate.
 *
 * Not a full shell parser. Handles the constructs that matter for command
 * interception and degrades to best-effort tokens on malformed input.
 * Never throws.
 *
 * Covered:
 * - single/double quotes and backslash escapes (quote-aware splitting)
 * - segment separators: ; | || && & and newlines (unquoted && subshell parens act as separators)
 * - heredoc bodies are skipped entirely (<<EOF / <<-EOF / <<'EOF' / <<"EOF")
 * - `--` is preserved as a token so argv parsing can stop flag scanning
 * - command substitution $(...) and `...` is tokenized recursively (inner
 *   text contains real commands) and also kept as literal token text
 * - file redirect targets (>, >>, N>, N>>, &>) recorded per segment,
 *   excluding fd duplication (>&2) and the /dev/null sink. Other /dev/*
 *   targets are kept so rules can catch redirects into block devices.
 */

export interface Segment {
	/** Resolved token values (quotes/escapes stripped), in order. */
	tokens: string[];
	/** Redirect targets that create or truncate files. */
	redirectTargets: string[];
}

export function tokenize(input: string): Segment[] {
	const segments: Segment[] = [];
	let seg: Segment = { tokens: [], redirectTargets: [] };
	let tok = "";
	let tokStarted = false;
	const heredocs: string[] = [];
	let i = 0;
	const n = input.length;

	function pushTok() {
		if (tokStarted) {
			seg.tokens.push(tok);
			tok = "";
			tokStarted = false;
		}
	}

	function pushSeg() {
		pushTok();
		if (seg.tokens.length > 0 || seg.redirectTargets.length > 0) segments.push(seg);
		seg = { tokens: [], redirectTargets: [] };
	}

	/** Extract inner text of $(...) or `...` starting at index i. Returns end index (one past closer). */
	function scanSubst(start: number): { end: number; inner: string } {
		if (input[start] === "`") {
			const end = input.indexOf("`", start + 1);
			return end === -1
				? { end: n, inner: input.slice(start + 1) }
				: { end: end + 1, inner: input.slice(start + 1, end) };
		}
		// $( ... ) with nesting and quote awareness
		let depth = 1;
		let j = start + 2;
		while (j < n && depth > 0) {
			const ch = input[j];
			if (ch === "(") depth++;
			else if (ch === ")") depth--;
			else if (ch === "'") {
				const e = input.indexOf("'", j + 1);
				j = e === -1 ? n : e + 1;
				continue;
			} else if (ch === '"') {
				j++;
				while (j < n && input[j] !== '"') {
					j += input[j] === "\\" ? 2 : 1;
				}
			}
			j++;
		}
		return { end: j, inner: input.slice(start + 2, depth === 0 ? j - 1 : j) };
	}

	/** Recursively tokenize a command substitution and keep the literal text on the current token. */
	function handleSubst(start: number): number {
		tokStarted = true;
		const { end, inner } = scanSubst(start);
		if (inner.trim()) segments.push(...tokenize(inner));
		tok += input.slice(start, end);
		return end;
	}

	/** Read a redirect target word starting at i (quote/escape aware). Mutates i via closure. */
	function readRedirectTarget(): string | undefined {
		while (i < n && (input[i] === " " || input[i] === "\t")) i++;
		let t = "";
		while (i < n) {
			const ch = input[i];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "|" || ch === "&") break;
			if (ch === "'") {
				const e = input.indexOf("'", i + 1);
				t += e === -1 ? input.slice(i + 1) : input.slice(i + 1, e);
				i = e === -1 ? n : e + 1;
				continue;
			}
			if (ch === '"') {
				const e = input.indexOf('"', i + 1);
				t += e === -1 ? input.slice(i + 1) : input.slice(i + 1, e);
				i = e === -1 ? n : e + 1;
				continue;
			}
			if (ch === "\\" && i + 1 < n) {
				t += input[i + 1];
				i += 2;
				continue;
			}
			if (ch === "<" || ch === ">") break;
			t += ch;
			i++;
		}
		return t || undefined;
	}

	while (i < n) {
		// Heredoc body: consume whole lines at line start until the delimiter line.
		if (heredocs.length > 0 && (i === 0 || input[i - 1] === "\n")) {
			const nl = input.indexOf("\n", i);
			const line = input.slice(i, nl === -1 ? n : nl);
			if (line.trim() === heredocs[0]) heredocs.shift();
			i = nl === -1 ? n : nl + 1;
			continue;
		}

		const c = input[i];

		if (c === " " || c === "\t") {
			pushTok();
			i++;
			continue;
		}
		if (c === "\n") {
			pushTok();
			pushSeg();
			i++;
			continue;
		}
		if (c === "\\") {
			if (i + 1 < n && input[i + 1] === "\n") {
				i += 2; // line continuation
				continue;
			}
			if (i + 1 < n) {
				tok += input[i + 1];
				tokStarted = true;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (c === "'") {
			tokStarted = true;
			const end = input.indexOf("'", i + 1);
			if (end === -1) {
				tok += input.slice(i + 1);
				i = n;
			} else {
				tok += input.slice(i + 1, end);
				i = end + 1;
			}
			continue;
		}
		if (c === '"') {
			tokStarted = true;
			i++;
			while (i < n && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < n && '\\$"`'.includes(input[i + 1])) {
					tok += input[i + 1];
					i += 2;
					continue;
				}
				if (input[i] === "`" || (input[i] === "$" && input[i + 1] === "(")) {
					i = handleSubst(i);
					continue;
				}
				tok += input[i];
				i++;
			}
			i++; // closing quote (or past end on unbalanced input)
			continue;
		}
		if (c === "`" || (c === "$" && input[i + 1] === "(")) {
			i = handleSubst(i);
			continue;
		}
		if (c === ";") {
			pushTok();
			pushSeg();
			i++;
			continue;
		}
		if (c === "|") {
			pushTok();
			pushSeg();
			i += input[i + 1] === "|" ? 2 : 1;
			continue;
		}
		if (c === "&") {
			if (input[i + 1] === ">") {
				// &> / &>> : redirect both stdout and stderr to a file
				pushTok();
				i += 2;
				if (input[i] === ">") i++;
				const t = readRedirectTarget();
				if (t && t !== "/dev/null") seg.redirectTargets.push(t);
				continue;
			}
			pushTok();
			pushSeg();
			i += input[i + 1] === "&" ? 2 : 1;
			continue;
		}
		if (c === "(" || c === ")") {
			// Unquoted subshell parens bound a command list; treat as separators.
			pushTok();
			pushSeg();
			i++;
			continue;
		}
		if (c === "<") {
			if (input[i + 1] === "<") {
				// Heredoc: record delimiter, body lines are skipped by the loop head.
				pushTok();
				let j = i + 2;
				if (input[j] === "-") j++;
				while (j < n && (input[j] === " " || input[j] === "\t")) j++;
				let delim = "";
				const q = input[j];
				if (q === "'" || q === '"') {
					const e = input.indexOf(q, j + 1);
					delim = input.slice(j + 1, e === -1 ? n : e);
					j = e === -1 ? n : e + 1;
				} else {
					while (j < n && /[A-Za-z0-9_]/.test(input[j])) {
						delim += input[j];
						j++;
					}
				}
				if (delim) heredocs.push(delim);
				i = j;
				continue;
			}
			// Input redirect: read-only, discard target.
			pushTok();
			i++;
			readRedirectTarget();
			continue;
		}
		if (c === ">") {
			// An all-digits token right before > is an fd number (2>, 1>>), not a real token.
			if (tokStarted && /^[0-9]+$/.test(tok)) {
				tok = "";
				tokStarted = false;
			}
			pushTok();
			i++;
			if (input[i] === ">") i++;
			if (input[i] === "&") {
				// >&2 style fd duplication: no file target.
				i++;
				while (i < n && /[0-9-]/.test(input[i])) i++;
				continue;
			}
			const t = readRedirectTarget();
			if (t && t !== "/dev/null") seg.redirectTargets.push(t);
			continue;
		}

		tok += c;
		tokStarted = true;
		i++;
	}

	pushTok();
	pushSeg();
	return segments;
}
