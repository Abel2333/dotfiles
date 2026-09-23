export const DEFAULT_STALL_SECONDS = 600;
export const WAIT_POLL_INTERVAL_MS = 1000;

// Wait defaults and stall floors share the same per-role observation values:
// a shorter explicit value is raised to the floor instead of shortening it.
const ROLE_OBSERVATION_SECONDS = Object.freeze({
  scout: 600,
  reviewer: 1200,
  feasibility: 1200,
  implementer: 1800,
});

// Hard lower bound for wait observations: even an explicit 0 is raised to the
// selected role floor, so a wait can never silently degrade into status polling.
export const MIN_WAIT_SECONDS = Math.min(
  ...Object.values(ROLE_OBSERVATION_SECONDS),
);

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "aborted",
  "orphaned",
]);

function requireSeconds(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function roleValues(agents) {
  return Array.from(agents ?? [], (agent) => ROLE_OBSERVATION_SECONDS[agent]).filter(
    (value) => value !== undefined,
  );
}

function snapshotId(snapshot) {
  return String(snapshot?.job?.id ?? snapshot?.live?.jobId ?? "unknown");
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eventTime(snapshot) {
  return (
    timestamp(snapshot?.live?.lastEventAt) ?? timestamp(snapshot?.job?.updatedAt)
  );
}

/** Return the default observation window for one delegated role. */
export function defaultWaitSeconds(agent) {
  const seconds = ROLE_OBSERVATION_SECONDS[agent];
  if (seconds === undefined) {
    throw new Error(`Unsupported subagent role for wait defaults: ${agent}`);
  }
  return seconds;
}

/**
 * Resolve an observation window against the longest selected role floor.
 *
 * Omitted values use the role floor. Explicit values, including 0, are raised
 * to the floor and never shorten the observation below MIN_WAIT_SECONDS;
 * longer explicit values keep their length.
 */
export function resolveWaitSeconds(agents, explicitWaitSeconds) {
  const values = roleValues(agents);
  const floor = values.length ? Math.max(...values) : MIN_WAIT_SECONDS;
  if (explicitWaitSeconds === undefined) {
    if (values.length === 0) {
      throw new Error("Cannot resolve a wait default without a delegated role");
    }
    return floor;
  }
  const seconds = requireSeconds(explicitWaitSeconds, "waitSeconds");
  return Math.max(seconds, floor);
}

/**
 * Resolve the inactivity threshold against the selected roles' stall floor.
 *
 * Omitted values use the longest selected role floor; 0 disables stall
 * observation; positive values are raised to the role floor.
 */
export function resolveStallSeconds(agents, explicitStallSeconds) {
  const values = roleValues(agents);
  const floor = values.length ? Math.max(...values) : DEFAULT_STALL_SECONDS;
  if (explicitStallSeconds === undefined) return floor;
  const seconds = requireSeconds(explicitStallSeconds, "stallSeconds");
  return seconds === 0 ? 0 : Math.max(seconds, floor);
}

/** Validate and deduplicate the public wait_many job identifier list. */
export function normalizeWaitJobIds(jobIds) {
  if (!Array.isArray(jobIds)) {
    throw new Error("action=wait_many requires jobIds");
  }
  const unique = [];
  for (const value of jobIds) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("jobIds must contain non-empty job ID references");
    }
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.length < 1 || unique.length > 2) {
    throw new Error("action=wait_many supports one or two unique job IDs");
  }
  return unique;
}

/** Determine whether an observed job state is terminal. */
export function isTerminalSnapshot(snapshot) {
  return TERMINAL_STATES.has(snapshot?.job?.state);
}

/** Evaluate the next return condition without mutating any observed job. */
export function evaluateObservation(snapshots, options) {
  const { deadlineAt, now, stallSeconds } = options;
  if (snapshots.every(isTerminalSnapshot)) {
    return { reason: "terminal", stalledJobIds: [], pendingApprovalJobIds: [] };
  }

  const pendingApprovalJobIds = snapshots
    .filter((snapshot) => snapshot?.pendingApprovals?.length)
    .map(snapshotId);
  if (pendingApprovalJobIds.length) {
    return {
      reason: "pending-approval",
      stalledJobIds: [],
      pendingApprovalJobIds,
    };
  }

  const stalledJobIds =
    stallSeconds === 0
      ? []
      : snapshots
          .filter((snapshot) => {
            if (isTerminalSnapshot(snapshot)) return false;
            const lastEventAt = eventTime(snapshot);
            return (
              lastEventAt !== undefined && now - lastEventAt >= stallSeconds * 1000
            );
          })
          .map(snapshotId);
  if (stalledJobIds.length) {
    return { reason: "stall", stalledJobIds, pendingApprovalJobIds: [] };
  }

  if (now >= deadlineAt) {
    return { reason: "deadline", stalledJobIds: [], pendingApprovalJobIds: [] };
  }
  return undefined;
}

/**
 * Observe one or two snapshots through a single refresh loop.
 *
 * The caller owns snapshot loading and cancellation. A cancelled wait rejects from
 * `wait` and never changes the observed child state.
 */
export async function observeSnapshots(options) {
  const {
    initialSnapshots,
    refresh,
    wait,
    now = () => Date.now(),
    onUpdate,
    waitSeconds,
    stallSeconds,
    pollIntervalMs = WAIT_POLL_INTERVAL_MS,
  } = options;
  if (!Array.isArray(initialSnapshots) || initialSnapshots.length === 0) {
    throw new Error("Observation requires at least one job snapshot");
  }
  const effectiveWaitSeconds = requireSeconds(waitSeconds, "waitSeconds");
  const effectiveStallSeconds = resolveStallSeconds(
    initialSnapshots.map((snapshot) => snapshot?.job?.agent),
    stallSeconds,
  );
  const effectivePollInterval = requireSeconds(pollIntervalMs, "pollIntervalMs");
  const deadlineAt = now() + effectiveWaitSeconds * 1000;
  let snapshots = initialSnapshots;

  for (;;) {
    onUpdate?.(snapshots);
    const outcome = evaluateObservation(snapshots, {
      deadlineAt,
      now: now(),
      stallSeconds: effectiveStallSeconds,
    });
    if (outcome) {
      return {
        snapshots,
        ...outcome,
        waitSeconds: effectiveWaitSeconds,
        stallSeconds: effectiveStallSeconds,
      };
    }

    const remaining = Math.max(1, deadlineAt - now());
    await wait(Math.min(effectivePollInterval, remaining));
    const refreshed = await refresh();
    if (!Array.isArray(refreshed) || refreshed.length === 0) {
      throw new Error("Observation refresh returned no job snapshots");
    }
    snapshots = refreshed;
  }
}
