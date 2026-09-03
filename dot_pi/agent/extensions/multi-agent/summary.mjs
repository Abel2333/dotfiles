// Summary text handling for delegated subagent tasks.
//
// SUMMARY_MAX_CHARS is mirrored as maxLength in the TypeBox schema of the
// subagent tool. The agent loop validates tool arguments against that schema
// before execute() runs, and TypeBox counts maxLength in UTF-16 code units,
// so over-long summaries are already rejected there. normalizeSummary applies
// the same limit so direct callers that bypass schema validation fail with a
// consistent, friendlier message.

export const SUMMARY_MAX_CHARS = 160;

export function normalizeSummary(value, agent) {
  const text = typeof value === "string" ? value : "";
  // Summaries are rendered as one-line titles; fold newlines and other
  // whitespace runs into single spaces so display lines cannot be broken.
  const summary = text.trim().replace(/\s+/g, " ");
  if (!summary) {
    throw new Error(
      `Each delegated ${agent} task requires a short one-line 'summary' (<= ${SUMMARY_MAX_CHARS} chars) describing the task; it is shown to the user in the UI.`,
    );
  }
  // Length in UTF-16 code units, matching the schema maxLength semantics.
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new Error(
      `summary must be <= ${SUMMARY_MAX_CHARS} characters; shorten it to a one-line task title.`,
    );
  }
  return summary;
}

export function fallbackSummary(task) {
  // Fallback for job records written before summaries existed: use the first
  // line of the task text, capped at SUMMARY_MAX_CHARS code points so list
  // lines stay comparable with summaries produced by normalizeSummary.
  const firstLine = String(task ?? "").split("\n", 1)[0]?.trim() ?? "";
  const units = Array.from(firstLine);
  return units.length > SUMMARY_MAX_CHARS
    ? units.slice(0, SUMMARY_MAX_CHARS).join("")
    : firstLine;
}
