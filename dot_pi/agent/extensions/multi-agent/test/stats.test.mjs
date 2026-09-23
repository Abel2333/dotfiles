import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateParentUsage,
  aggregateSubagentStats,
  collectSubagentHistory,
} from "../stats.mjs";

function usage(input, output, cacheRead, cacheWrite, cost, contextTokens, turns) {
  return { input, output, cacheRead, cacheWrite, cost, contextTokens, turns };
}

function snapshot(id, agent, model, state, options = {}) {
  return {
    job: {
      id,
      agent,
      model,
      state,
      createdAt: options.createdAt ?? "1970-01-01T00:00:00.000Z",
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      updatedAt: options.updatedAt,
    },
    live: {
      usage: options.usage,
      updatedAt: options.updatedAt,
    },
  };
}

function toolEntry(id, action, jobs) {
  return {
    type: "message",
    id,
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { action, jobs: jobs.map((job) => ({ job: { id: job } })) },
    },
  };
}

test("stats history collects only active-branch subagent details and deduplicates job IDs", () => {
  const entries = [
    toolEntry("start", "start", ["job-1"]),
    toolEntry("wait", "wait", ["job-1", "job-2"]),
    toolEntry("result", "result", ["job-1"]),
    toolEntry("many", "wait_many", ["job-1", "job-1", "job-2"]),
    toolEntry("abort", "abort", ["job-2"]),
    {
      type: "message",
      message: { role: "toolResult", toolName: "other", details: {} },
    },
  ];

  assert.deepEqual(collectSubagentHistory(entries), {
    jobIds: ["job-1", "job-2"],
    actionEvents: [
      { jobId: "job-1", action: "start" },
      { jobId: "job-1", action: "wait" },
      { jobId: "job-2", action: "wait" },
      { jobId: "job-1", action: "result" },
      { jobId: "job-1", action: "wait" },
      { jobId: "job-2", action: "wait" },
      { jobId: "job-2", action: "abort" },
    ],
  });
});

test("stats aggregates each retained live snapshot once by role and model", () => {
  const history = collectSubagentHistory([
    toolEntry("start", "start", ["job-1"]),
    toolEntry("wait", "wait", ["job-1", "job-2"]),
    toolEntry("result", "result", ["job-1"]),
    toolEntry("many", "wait_many", ["job-1", "job-1", "job-2"]),
    toolEntry("abort", "abort", ["job-2"]),
  ]);
  const first = snapshot("job-1", "scout", "model-a", "completed", {
    startedAt: "1970-01-01T00:00:01.000Z",
    endedAt: "1970-01-01T00:00:05.000Z",
    updatedAt: "1970-01-01T00:00:04.000Z",
    usage: usage(10, 20, 3, 4, 1.5, 200, 2),
  });
  const second = snapshot("job-2", "reviewer", "model-b", "failed", {
    endedAt: "1970-01-01T00:00:03.000Z",
    updatedAt: "1970-01-01T00:00:03.000Z",
    usage: usage(30, 40, 5, 6, 2.5, 100, 3),
  });
  const stats = aggregateSubagentStats({
    snapshots: [first, second, first],
    actionEvents: history.actionEvents,
    referencedJobIds: history.jobIds,
    now: 10_000,
  });

  assert.equal(stats.referencedJobs, 2);
  assert.equal(stats.availableJobs, 2);
  assert.deepEqual(stats.unavailableJobIds, []);
  assert.deepEqual(stats.child.usage, usage(40, 60, 8, 10, 4, 200, 5));
  assert.deepEqual(stats.child.timing, {
    queuedMs: 4000,
    runningMs: 4000,
    wallMs: 8000,
  });
  assert.deepEqual(stats.child.actions, {
    start: 1,
    wait: 4,
    status: 0,
    result: 1,
    failure: 1,
    abort: 1,
  });
  assert.deepEqual(stats.groups, [
    {
      agent: "reviewer",
      model: "model-b",
      jobs: 1,
      usage: usage(30, 40, 5, 6, 2.5, 100, 3),
      timing: { queuedMs: 3000, runningMs: 0, wallMs: 3000 },
      actions: {
        start: 0,
        wait: 2,
        status: 0,
        result: 0,
        failure: 1,
        abort: 1,
      },
    },
    {
      agent: "scout",
      model: "model-a",
      jobs: 1,
      usage: usage(10, 20, 3, 4, 1.5, 200, 2),
      timing: { queuedMs: 1000, runningMs: 4000, wallMs: 5000 },
      actions: {
        start: 1,
        wait: 2,
        status: 0,
        result: 1,
        failure: 0,
        abort: 0,
      },
    },
  ]);
});

test("stats history ignores display snapshots for unrelated jobs", () => {
  const history = collectSubagentHistory([
    toolEntry("start", "start", ["owned"]),
    toolEntry("list", "list", ["unrelated"]),
    toolEntry("stats", "stats", ["unrelated"]),
  ]);
  assert.deepEqual(history, {
    jobIds: ["owned"],
    actionEvents: [{ jobId: "owned", action: "start" }],
  });

  const owned = snapshot("owned", "scout", "model", "completed", {
    endedAt: "1970-01-01T00:00:01.000Z",
    usage: usage(11, 12, 13, 14, 1.25, 15, 16),
  });
  const unrelated = snapshot("unrelated", "reviewer", "other", "completed", {
    endedAt: "1970-01-01T00:00:01.000Z",
    usage: usage(101, 102, 103, 104, 9.75, 105, 106),
  });
  const stats = aggregateSubagentStats({
    snapshots: [owned, unrelated].filter((item) => history.jobIds.includes(item.job.id)),
    actionEvents: history.actionEvents,
    referencedJobIds: history.jobIds,
    now: 1000,
  });

  assert.equal(stats.referencedJobs, 1);
  assert.equal(stats.availableJobs, 1);
  assert.equal(stats.child.usage.input, 11);
  assert.equal(stats.child.usage.cost, 1.25);
});

test("stats history retains authorization as a direct job reference", () => {
  assert.deepEqual(
    collectSubagentHistory([toolEntry("authorize", "authorize", ["approval-job"])]),
    {
      jobIds: ["approval-job"],
      actionEvents: [],
    },
  );
});

test("stats reports unavailable retained jobs without rescanning child sessions", () => {
  const available = snapshot("available", "scout", "model", "completed", {
    endedAt: "1970-01-01T00:00:01.000Z",
    usage: usage(1, 2, 3, 4, 5, 6, 7),
  });
  const stats = aggregateSubagentStats({
    snapshots: [available],
    referencedJobIds: ["available", "removed", "available"],
    now: 1000,
  });

  assert.equal(stats.referencedJobs, 2);
  assert.equal(stats.availableJobs, 1);
  assert.deepEqual(stats.unavailableJobIds, ["removed"]);
  assert.deepEqual(stats.child.usage, usage(1, 2, 3, 4, 5, 6, 7));
});

test("parent usage stays separate and uses the newest context value", () => {
  const parent = aggregateParentUsage([
    {
      type: "message",
      timestamp: "1970-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        usage: {
          input: 100,
          output: 10,
          cacheRead: 20,
          cacheWrite: 30,
          totalTokens: 1000,
          cost: { total: 1 },
        },
      },
    },
    {
      type: "message",
      timestamp: "1970-01-01T00:00:02.000Z",
      message: { role: "assistant" },
    },
    {
      type: "message",
      timestamp: "1970-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        usage: {
          input: 200,
          output: 40,
          cacheRead: 50,
          cacheWrite: 60,
          totalTokens: 2000,
          cost: { total: 2 },
        },
      },
    },
  ]);

  assert.deepEqual(parent, {
    usage: {
      input: 300,
      output: 50,
      cacheRead: 70,
      cacheWrite: 90,
      cost: 3,
      contextTokens: 2000,
      turns: 2,
    },
  });
});
