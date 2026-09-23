import { truncateUtf8 } from "./limits.mjs";

export const RESULT_SUMMARY_OUTPUT_CAP = 4096;
export const RESULT_ACTIVITY_PREVIEW_CAP = 1024;
export const RESULT_ACTIVITY_PREVIEW_EVENT_LIMIT = 4;

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function oneLine(value, maxBytes = 240) {
  return truncateUtf8(String(value ?? "").replace(/\s+/g, " ").trim(), maxBytes);
}

/** Format elapsed milliseconds for compact delegated-job status text. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(number(ms) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Format token counts without exposing unbounded raw values. */
export function formatTokens(value) {
  const tokens = number(value);
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatCost(value) {
  const cost = number(value);
  if (cost === 0) return "0";
  if (Math.abs(cost) < 0.01) return cost.toFixed(4);
  return cost.toFixed(2);
}

/** Format a usage summary where context tokens are a last-turn value, not a sum. */
export function formatUsage(usage) {
  const current = usage ?? {};
  const cache = number(current.cacheRead) + number(current.cacheWrite);
  return `in ${formatTokens(current.input)}, out ${formatTokens(current.output)}, cache ${formatTokens(cache)}, cost ${formatCost(current.cost)}, turns ${formatTokens(current.turns)}, ctx ${formatTokens(current.contextTokens)}`;
}

function observationMarker(snapshot, observation) {
  if (!observation) return undefined;
  if (
    observation.reason === "pending-approval" &&
    observation.pendingApprovalJobIds?.includes(snapshot.job.id)
  ) {
    return "approval pending";
  }
  if (
    observation.reason === "stall" &&
    observation.stalledJobIds?.includes(snapshot.job.id)
  ) {
    return "stalled observation; child continues";
  }
  if (observation.reason === "deadline") {
    return "observation deadline; child continues";
  }
  return undefined;
}

function nextAction(snapshot, observation) {
  const approval = snapshot.pendingApprovals?.[0];
  if (approval) {
    return `authorize jobId=${snapshot.job.id} requestId=${approval.id}`;
  }
  if (observation?.reason === "stall" || observation?.reason === "deadline") {
    return "wait again to keep observing";
  }
  if (snapshot.job.state === "completed") {
    if (snapshot.job.agent === "reviewer") {
      return "request result, adjudicate findings, then send accepted Finding IDs to a remediation implementer";
    }
    return "request result when detailed output is needed";
  }
  if (snapshot.job.state === "failed" || snapshot.job.state === "orphaned") {
    if (snapshot.job.agent === "implementer") {
      return "start a continuation implementer with the approved plan; parent project edits remain blocked";
    }
    if (snapshot.job.agent === "reviewer") {
      return "adjudicate findings and send accepted Finding IDs to a remediation implementer";
    }
    return "inspect result and error details";
  }
  if (snapshot.job.state === "aborted") return "inspect result or start a new approved task";
  return "wait for a state change";
}

function compactActivity(live) {
  if (live.currentTool?.name) {
    return `tool ${oneLine(live.currentTool.name, 80)}`;
  }
  const activity = oneLine(live.activity, 220);
  return activity.startsWith("tool:") ? "tool active" : activity || "waiting";
}

function compactError(snapshot) {
  if (![
    "failed",
    "orphaned",
  ].includes(snapshot.job.state)) {
    return "";
  }
  const error = snapshot.job.errorMessage || snapshot.live?.errorMessage;
  return error ? ` error=${oneLine(error, 240)}` : "";
}

function formatRecentActivity(snapshot) {
  const activities = Array.isArray(snapshot.activities) ? snapshot.activities : [];
  if (activities.length === 0) return "recent activity: none";
  const lines = activities
    .slice(-RESULT_ACTIVITY_PREVIEW_EVENT_LIMIT)
    .map((event) => {
      const parts = [String(number(event?.seq)), oneLine(event?.type, 80)];
      if (event?.toolName) parts.push(oneLine(event.toolName, 80));
      if (event?.summary) parts.push(oneLine(event.summary, 160));
      return parts.filter(Boolean).join(" ");
    });
  return `recent activity:\n${truncateUtf8(lines.join("\n"), RESULT_ACTIVITY_PREVIEW_CAP, {
    tailBytes: 256,
    reportOmitted: true,
  })}`;
}

/** Render one compact job line without session paths, raw arguments, or output. */
export function formatCompactSnapshot(snapshot, observation) {
  const job = snapshot.job;
  const live = snapshot.live ?? {};
  const approval = snapshot.pendingApprovals?.[0];
  const activity = compactActivity(live);
  const marker = observationMarker(snapshot, observation);
  const approvalText = approval
    ? ` approval=${approval.id}(${oneLine(approval.ruleName, 80)})`
    : "";
  const errorText = compactError(snapshot);
  return `job=${job.id} agent=${job.agent} state=${job.state} elapsed=${formatDuration(snapshot.elapsedMs)} activity=${activity} usage=${formatUsage(live.usage)}${marker ? ` observation=${marker}` : ""}${approvalText}${errorText} next=${nextAction(snapshot, observation)}`;
}

/** Render compact one-line-per-job content for status and observation actions. */
export function formatCompactSnapshots(snapshots, observation) {
  return snapshots
    .map((snapshot) => formatCompactSnapshot(snapshot, observation))
    .join("\n");
}

/** Keep a small head/tail preview for default result content. */
export function summarizeResultOutput(output) {
  return truncateUtf8(String(output ?? ""), RESULT_SUMMARY_OUTPUT_CAP, {
    tailBytes: 1024,
    reportOmitted: true,
  });
}

/** Render either summary or explicitly requested bounded full delegated output. */
export function formatResultContent(snapshot, output, view) {
  const label = snapshot.job.state === "completed" ? "final output" : "current output";
  const rendered = view === "full" ? output : summarizeResultOutput(output);
  return [
    formatCompactSnapshot(snapshot),
    "",
    `activity cursor: ${number(snapshot.nextCursor)}`,
    formatRecentActivity(snapshot),
    "",
    `${label}${view === "summary" ? " summary" : ""}:`,
    rendered || "(no assistant output yet)",
  ].join("\n");
}

function formatActionCounts(actions) {
  return ["start", "wait", "status", "result", "failure", "abort"]
    .map((name) => `${name}=${number(actions?.[name])}`)
    .join(" ");
}

/** Render compact parent-versus-child accounting without returning tool usage. */
export function formatStatsSummary(stats) {
  const parent = stats.parent ?? { usage: {} };
  const child = stats.child ?? { usage: {}, timing: {}, actions: {} };
  const lines = [
    `Subagent stats: ${number(stats.availableJobs)}/${number(stats.referencedJobs)} retained job(s) from this active branch.`,
    `Parent direct: ${formatUsage(parent.usage)}.`,
    `Child unique: ${formatUsage(child.usage)}; queued=${formatDuration(child.timing?.queuedMs)} running=${formatDuration(child.timing?.runningMs)} wall=${formatDuration(child.timing?.wallMs)}; ${formatActionCounts(child.actions)}.`,
  ];
  for (const group of (stats.groups ?? []).slice(0, 8)) {
    lines.push(
      `${group.agent}/${group.model}: jobs=${number(group.jobs)} ${formatUsage(group.usage)}; queued=${formatDuration(group.timing?.queuedMs)} running=${formatDuration(group.timing?.runningMs)} wall=${formatDuration(group.timing?.wallMs)}; ${formatActionCounts(group.actions)}.`,
    );
  }
  if ((stats.groups ?? []).length > 8) {
    lines.push(`Additional role/model groups: ${(stats.groups ?? []).length - 8}.`);
  }
  if (stats.unavailableJobIds?.length) {
    lines.push(`Unavailable retained jobs: ${stats.unavailableJobIds.join(", ")}.`);
  }
  return lines.join("\n");
}
