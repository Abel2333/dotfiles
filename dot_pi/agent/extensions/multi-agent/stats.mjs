const ACTION_NAMES = new Set(["start", "wait", "status", "result", "abort"]);
const REFERENCE_ACTION_NAMES = new Set([...ACTION_NAMES, "authorize"]);

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function emptyActions() {
  return { start: 0, wait: 0, status: 0, result: 0, failure: 0, abort: 0 };
}

function emptyTiming() {
  return { queuedMs: 0, runningMs: 0, wallMs: 0 };
}

function cost(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return number(value?.total);
}

function addUsage(target, usage) {
  target.input += number(usage?.input);
  target.output += number(usage?.output);
  target.cacheRead += number(usage?.cacheRead);
  target.cacheWrite += number(usage?.cacheWrite);
  target.cost += cost(usage?.cost);
}

function setLastContext(target, current, usage, updatedAt) {
  const observedAt = timestamp(updatedAt) ?? -Infinity;
  if (observedAt < current.updatedAt) return;
  target.contextTokens = number(usage?.contextTokens ?? usage?.totalTokens);
  current.updatedAt = observedAt;
}

function addTiming(target, snapshot, now) {
  const job = snapshot?.job ?? {};
  const createdAt = timestamp(job.createdAt);
  if (createdAt === undefined) return;
  const startedAt = timestamp(job.startedAt);
  const endedAt = timestamp(job.endedAt) ?? now;
  const finishedAt = Math.max(createdAt, endedAt);
  target.wallMs += finishedAt - createdAt;
  if (startedAt === undefined) {
    target.queuedMs += finishedAt - createdAt;
    return;
  }
  const runningAt = Math.max(createdAt, startedAt);
  target.queuedMs += runningAt - createdAt;
  target.runningMs += Math.max(runningAt, finishedAt) - runningAt;
}

function validJobId(value) {
  return typeof value === "string" && value.length > 0;
}

function actionName(value) {
  if (value === "wait_many") return "wait";
  return REFERENCE_ACTION_NAMES.has(value) ? value : undefined;
}

/** Extract unique job IDs and per-job action history from the active parent branch. */
export function collectSubagentHistory(entries) {
  const jobIds = [];
  const actionEvents = [];
  for (const [entryIndex, entry] of (entries ?? []).entries()) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "subagent") {
      continue;
    }
    const details = message.details;
    if (!details || typeof details !== "object" || !Array.isArray(details.jobs)) {
      continue;
    }
    const action = actionName(details.action);
    if (!action) continue;
    const seenActionJobs = new Set();
    for (const snapshot of details.jobs) {
      const id = snapshot?.job?.id;
      if (!validJobId(id)) continue;
      if (!jobIds.includes(id)) jobIds.push(id);
      const eventKey = `${entry.id ?? entryIndex}\u0000${action}\u0000${id}`;
      if (ACTION_NAMES.has(action) && !seenActionJobs.has(eventKey)) {
        actionEvents.push({ jobId: id, action });
        seenActionJobs.add(eventKey);
      }
    }
  }
  return { jobIds, actionEvents };
}

/** Aggregate direct parent assistant usage from the active parent branch. */
export function aggregateParentUsage(entries) {
  const usage = emptyUsage();
  const lastContext = { updatedAt: -Infinity };
  for (const entry of entries ?? []) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !message.usage) continue;
    addUsage(usage, message.usage);
    usage.turns += 1;
    setLastContext(usage, lastContext, message.usage, entry.timestamp ?? message.timestamp);
  }
  return { usage };
}

function createGroup(agent, model) {
  return {
    agent,
    model,
    jobs: 0,
    usage: emptyUsage(),
    timing: emptyTiming(),
    actions: emptyActions(),
    _lastContext: { updatedAt: -Infinity },
  };
}

function finalizeGroup(group) {
  const { _lastContext, ...publicGroup } = group;
  return publicGroup;
}

/**
 * Aggregate unique child live usage, timings, and parent-observed actions.
 *
 * It intentionally accepts snapshots only; callers must not rescan child session
 * files for usage, which would duplicate or reinterpret Supervisor accounting.
 */
export function aggregateSubagentStats(options) {
  const {
    snapshots = [],
    actionEvents = [],
    referencedJobIds = [],
    now = Date.now(),
  } = options ?? {};
  const uniqueSnapshots = [];
  const seen = new Set();
  for (const snapshot of snapshots) {
    const id = snapshot?.job?.id;
    if (!validJobId(id) || seen.has(id)) continue;
    seen.add(id);
    uniqueSnapshots.push(snapshot);
  }

  const eventsByJob = new Map();
  for (const event of actionEvents) {
    if (!seen.has(event?.jobId) || !ACTION_NAMES.has(event.action)) continue;
    const events = eventsByJob.get(event.jobId) ?? [];
    events.push(event.action);
    eventsByJob.set(event.jobId, events);
  }

  const child = createGroup("all", "all");
  const groups = new Map();
  for (const snapshot of uniqueSnapshots) {
    const agent =
      typeof snapshot.job?.agent === "string" && snapshot.job.agent
        ? snapshot.job.agent
        : "unknown";
    const model =
      typeof snapshot.job?.model === "string" && snapshot.job.model
        ? snapshot.job.model
        : "unknown";
    const key = `${agent}\u0000${model}`;
    const group = groups.get(key) ?? createGroup(agent, model);
    groups.set(key, group);
    for (const target of [child, group]) {
      target.jobs += 1;
      addUsage(target.usage, snapshot.live?.usage);
      target.usage.turns += number(snapshot.live?.usage?.turns);
      setLastContext(
        target.usage,
        target._lastContext,
        snapshot.live?.usage,
        snapshot.live?.updatedAt ?? snapshot.job?.updatedAt,
      );
      addTiming(target.timing, snapshot, now);
      for (const action of eventsByJob.get(snapshot.job.id) ?? []) {
        target.actions[action] += 1;
      }
      if (snapshot.job?.state === "failed") target.actions.failure += 1;
    }
  }

  const requested = Array.from(
    new Set((referencedJobIds ?? []).filter(validJobId)),
  );
  return {
    referencedJobs: requested.length,
    availableJobs: uniqueSnapshots.length,
    unavailableJobIds: requested.filter((id) => !seen.has(id)),
    child: finalizeGroup(child),
    groups: [...groups.values()]
      .map(finalizeGroup)
      .sort((left, right) => {
        const leftKey = `${left.agent}/${left.model}`;
        const rightKey = `${right.agent}/${right.model}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}
