import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STALL_SECONDS,
  MIN_WAIT_SECONDS,
  evaluateObservation,
  normalizeWaitJobIds,
  observeSnapshots,
  resolveStallSeconds,
  resolveWaitSeconds,
} from "../wait-policy.mjs";

function snapshot(id, state = "running", options = {}) {
  const eventAt = options.eventAt ?? new Date(0).toISOString();
  return {
    job: {
      id,
      agent: options.agent ?? "scout",
      state,
      updatedAt: eventAt,
    },
    live: {
      lastEventAt: eventAt,
      updatedAt: eventAt,
    },
    pendingApprovals: options.pendingApprovals ?? [],
  };
}

test("wait policy resolves role defaults and raises short waits", () => {
  assert.equal(resolveWaitSeconds(["scout"]), 600);
  assert.equal(resolveWaitSeconds(["reviewer"]), 1200);
  assert.equal(resolveWaitSeconds(["feasibility"]), 1200);
  assert.equal(resolveWaitSeconds(["implementer"]), 1800);
  assert.equal(resolveWaitSeconds(["scout", "implementer"]), 1800);
  assert.equal(resolveWaitSeconds(["scout"], 300), 600);
  assert.equal(resolveWaitSeconds(["reviewer"], 300), 1200);
  assert.equal(resolveWaitSeconds(["scout", "implementer"], 1200), 1800);
  assert.equal(resolveWaitSeconds(["implementer"], 3600), 3600);
  assert.equal(resolveWaitSeconds(["unknown"], 300), MIN_WAIT_SECONDS);
  assert.equal(resolveWaitSeconds(["unknown"], 3600), 3600);
  assert.throws(() => resolveWaitSeconds(["scout"], -1), /finite non-negative/);
});

test("explicit waitSeconds zero is raised to the role floor", () => {
  assert.equal(resolveWaitSeconds(["scout"], 0), 600);
  assert.equal(resolveWaitSeconds(["reviewer"], 0), 1200);
  assert.equal(resolveWaitSeconds(["feasibility"], 0), 1200);
  assert.equal(resolveWaitSeconds(["implementer"], 0), 1800);
  assert.equal(resolveWaitSeconds(["scout", "implementer"], 0), 1800);
  assert.equal(resolveWaitSeconds(["unknown"], 0), MIN_WAIT_SECONDS);
});

test("stall policy floors explicit values by the selected roles", () => {
  assert.equal(resolveStallSeconds(["scout"], undefined), 600);
  assert.equal(resolveStallSeconds(["reviewer"], undefined), 1200);
  assert.equal(resolveStallSeconds(["feasibility"], undefined), 1200);
  assert.equal(resolveStallSeconds(["implementer"], undefined), 1800);
  assert.equal(resolveStallSeconds(["scout", "implementer"], undefined), 1800);
  assert.equal(resolveStallSeconds(["scout"], 0), 0);
  assert.equal(resolveStallSeconds(["scout"], 30), 600);
  assert.equal(resolveStallSeconds(["reviewer"], 30), 1200);
  assert.equal(resolveStallSeconds(["implementer"], 900), 1800);
  assert.equal(resolveStallSeconds(["implementer"], 3600), 3600);
  assert.equal(resolveStallSeconds(["unknown"], 30), DEFAULT_STALL_SECONDS);
  assert.equal(resolveStallSeconds(["unknown"], 900), 900);
  assert.equal(resolveStallSeconds([], undefined), DEFAULT_STALL_SECONDS);
  assert.throws(() => resolveStallSeconds(["scout"], -1), /finite non-negative/);
});

test("wait_many job references are deduplicated and bounded", () => {
  assert.deepEqual(normalizeWaitJobIds(["first", "first", "second"]), [
    "first",
    "second",
  ]);
  assert.throws(() => normalizeWaitJobIds([]), /one or two/);
  assert.throws(() => normalizeWaitJobIds(["one", "two", "three"]), /one or two/);
  assert.throws(() => normalizeWaitJobIds(["one", " "]), /non-empty/);
  assert.throws(() => normalizeWaitJobIds(undefined), /requires jobIds/);
});

test("observation evaluates terminal, approval, stall, and deadline wake conditions", () => {
  const terminal = evaluateObservation(
    [snapshot("done", "completed")],
    { deadlineAt: 1000, now: 0, stallSeconds: 600 },
  );
  assert.deepEqual(terminal, {
    reason: "terminal",
    stalledJobIds: [],
    pendingApprovalJobIds: [],
  });

  const approval = evaluateObservation(
    [
      snapshot("waiting", "running", {
        pendingApprovals: [{ id: "approval-1" }],
      }),
      snapshot("done", "completed"),
    ],
    { deadlineAt: 1000, now: 0, stallSeconds: 600 },
  );
  assert.deepEqual(approval, {
    reason: "pending-approval",
    stalledJobIds: [],
    pendingApprovalJobIds: ["waiting"],
  });

  const stalled = evaluateObservation(
    [snapshot("slow")],
    { deadlineAt: 20_000, now: 10_000, stallSeconds: 5 },
  );
  assert.deepEqual(stalled, {
    reason: "stall",
    stalledJobIds: ["slow"],
    pendingApprovalJobIds: [],
  });

  const deadline = evaluateObservation(
    [snapshot("running")],
    { deadlineAt: 10_000, now: 10_000, stallSeconds: 0 },
  );
  assert.deepEqual(deadline, {
    reason: "deadline",
    stalledJobIds: [],
    pendingApprovalJobIds: [],
  });
});

test("stall observation floors the threshold by the observed role", async () => {
  const running = snapshot("slow", "running", { agent: "reviewer" });
  let now = 700_000;
  let waits = 0;
  const result = await observeSnapshots({
    initialSnapshots: [running],
    refresh: async () => [running],
    wait: async () => {
      waits += 1;
      now = 1_200_000;
    },
    now: () => now,
    waitSeconds: 1800,
    stallSeconds: 30,
  });

  assert.equal(waits, 1);
  assert.equal(result.reason, "stall");
  assert.equal(result.stallSeconds, 1200);
  assert.deepEqual(result.stalledJobIds, ["slow"]);
});

test("wait_many uses the longest stall floor across observed roles", async () => {
  const scout = snapshot("scout-first", "running", { agent: "scout" });
  const implementer = snapshot("impl-second", "running", { agent: "implementer" });
  let now = 1_199_000;
  let waits = 0;
  const result = await observeSnapshots({
    initialSnapshots: [scout, implementer],
    refresh: async () => [scout, implementer],
    wait: async () => {
      waits += 1;
      now = 1_800_000;
    },
    now: () => now,
    waitSeconds: 3600,
    stallSeconds: 60,
  });

  assert.equal(waits, 1);
  assert.equal(result.reason, "stall");
  assert.equal(result.stallSeconds, 1800);
  assert.deepEqual(result.stalledJobIds, ["scout-first", "impl-second"]);
});

test("observation returns immediately for terminal or approval states without waiting", async () => {
  for (const initialSnapshots of [
    [snapshot("done", "completed")],
    [snapshot("approval", "running", { pendingApprovals: [{ id: "a-1" }] })],
  ]) {
    let waitCalls = 0;
    const result = await observeSnapshots({
      initialSnapshots,
      refresh: async () => {
        throw new Error("terminal and approval observations must not refresh");
      },
      wait: async () => {
        waitCalls += 1;
      },
      now: () => 0,
      waitSeconds: 60,
      stallSeconds: 600,
    });
    assert.equal(waitCalls, 0);
    assert.ok(["terminal", "pending-approval"].includes(result.reason));
  }
});

test("stall observation returns without mutating the running child snapshot", async () => {
  const running = snapshot("slow");
  let waitCalls = 0;
  const result = await observeSnapshots({
    initialSnapshots: [running],
    refresh: async () => [running],
    wait: async () => {
      waitCalls += 1;
    },
    now: () => 600_000,
    waitSeconds: 60,
    stallSeconds: 600,
  });

  assert.equal(result.reason, "stall");
  assert.deepEqual(result.stalledJobIds, ["slow"]);
  assert.equal(result.stallSeconds, 600);
  assert.equal(waitCalls, 0);
  assert.equal(running.job.state, "running");
});

test("stallSeconds zero observes through the deadline", async () => {
  const running = snapshot("long-running");
  let now = 0;
  let refreshes = 0;
  const waits = [];
  const result = await observeSnapshots({
    initialSnapshots: [running],
    refresh: async () => {
      refreshes += 1;
      return [running];
    },
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    now: () => now,
    waitSeconds: 2,
    stallSeconds: 0,
  });

  assert.equal(result.reason, "deadline");
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(refreshes, 2);
  assert.equal(running.job.state, "running");
});

test("wait_many observation uses one refresh loop until all jobs are terminal", async () => {
  const first = snapshot("first");
  const second = snapshot("second", "completed");
  const completedFirst = snapshot("first", "completed");
  let now = 0;
  let refreshes = 0;
  const updates = [];
  const result = await observeSnapshots({
    initialSnapshots: [first, second],
    refresh: async () => {
      refreshes += 1;
      return [completedFirst, second];
    },
    wait: async (ms) => {
      now += ms;
    },
    now: () => now,
    onUpdate: (snapshots) => updates.push(snapshots.map((item) => item.job.state)),
    waitSeconds: 60,
    stallSeconds: 0,
  });

  assert.equal(result.reason, "terminal");
  assert.equal(refreshes, 1);
  assert.deepEqual(updates, [["running", "completed"], ["completed", "completed"]]);
});

test("wait_many wakes when either job requests approval or stalls", async () => {
  const approval = await observeSnapshots({
    initialSnapshots: [
      snapshot("first"),
      snapshot("second", "running", { pendingApprovals: [{ id: "a-1" }] }),
    ],
    refresh: async () => [],
    wait: async () => {},
    now: () => 0,
    waitSeconds: 60,
    stallSeconds: 0,
  });
  assert.equal(approval.reason, "pending-approval");
  assert.deepEqual(approval.pendingApprovalJobIds, ["second"]);

  const stalled = await observeSnapshots({
    initialSnapshots: [snapshot("first"), snapshot("second")],
    refresh: async () => [],
    wait: async () => {},
    now: () => 600_000,
    waitSeconds: 60,
    stallSeconds: 600,
  });
  assert.equal(stalled.reason, "stall");
  assert.deepEqual(stalled.stalledJobIds, ["first", "second"]);
});

test("observation propagates cancellation without changing child state", async () => {
  const running = snapshot("cancelled");
  await assert.rejects(
    observeSnapshots({
      initialSnapshots: [running],
      refresh: async () => [running],
      wait: async () => {
        throw new Error("Wait cancelled; subagent continues running");
      },
      now: () => 0,
      waitSeconds: 60,
      stallSeconds: 0,
    }),
    /Wait cancelled; subagent continues running/,
  );
  assert.equal(running.job.state, "running");
});
