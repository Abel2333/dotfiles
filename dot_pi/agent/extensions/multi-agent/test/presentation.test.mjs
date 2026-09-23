import assert from "node:assert/strict";
import test from "node:test";
import {
  RESULT_ACTIVITY_PREVIEW_CAP,
  RESULT_SUMMARY_OUTPUT_CAP,
  formatCompactSnapshot,
  formatCompactSnapshots,
  formatResultContent,
  formatStatsSummary,
  formatUsage,
  summarizeResultOutput,
} from "../presentation.mjs";

function snapshot(overrides = {}) {
  return {
    job: {
      id: "job-12345678",
      agent: "reviewer",
      state: "running",
      sessionPath: "/private/sessions/job.jsonl",
      ...overrides.job,
    },
    live: {
      activity: "tool: bash git status --short --untracked-files=all",
      usage: {
        input: 1200,
        output: 200,
        cacheRead: 300,
        cacheWrite: 40,
        cost: 1.25,
        contextTokens: 4096,
        turns: 3,
      },
      currentTool: {
        name: "bash",
        summary: "git status --short --token=private-token",
        arguments: { command: "git status --token=private-token" },
      },
      partialAssistantOutput: "private in-progress output",
      ...overrides.live,
    },
    elapsedMs: 65_000,
    pendingApprovals: overrides.pendingApprovals,
  };
}

test("compact job rendering omits session paths, tool arguments, and output", () => {
  const rendered = formatCompactSnapshot(snapshot());
  assert.match(rendered, /^job=job-12345678 agent=reviewer state=running elapsed=1m 5s/);
  assert.match(rendered, /activity=tool bash/);
  assert.match(rendered, /usage=in 1\.2k, out 200, cache 340, cost 1\.25, turns 3, ctx 4\.1k/);
  assert.doesNotMatch(rendered, /private-token|private\/sessions|in-progress output/);
  assert.match(rendered, /next=wait for a state change/);
});

test("compact job rendering includes authorization and observation next actions", () => {
  const approval = snapshot({
    pendingApprovals: [{ id: "approval-1", ruleName: "write-rule" }],
  });
  const rendered = formatCompactSnapshots([approval], {
    reason: "pending-approval",
    stalledJobIds: [],
    pendingApprovalJobIds: ["job-12345678"],
  });
  assert.match(rendered, /approval=approval-1\(write-rule\)/);
  assert.match(rendered, /next=authorize jobId=job-12345678 requestId=approval-1/);
  const multi = formatCompactSnapshots(
    [approval, snapshot({ job: { id: "other-job" } })],
    {
      reason: "pending-approval",
      stalledJobIds: [],
      pendingApprovalJobIds: ["job-12345678"],
    },
  ).split("\n");
  assert.match(multi[0], /observation=approval pending/);
  assert.doesNotMatch(multi[1], /observation=approval pending/);

  const stalled = formatCompactSnapshot(snapshot(), {
    reason: "stall",
    stalledJobIds: ["job-12345678"],
    pendingApprovalJobIds: [],
  });
  assert.match(stalled, /observation=stalled observation; child continues/);
  assert.match(stalled, /next=wait again to keep observing/);
});

test("result summary retains a bounded head and tail, activity cursor, and preview", () => {
  const output = `HEAD-${"x".repeat(12_000)}-TAIL`;
  const result = {
    ...snapshot({ job: { state: "completed" } }),
    nextCursor: 42,
    activities: Array.from({ length: 6 }, (_, index) => ({
      seq: index + 1,
      type: "tool_end",
      toolName: "bash",
      summary: `event-${index + 1}-${"x".repeat(400)}`,
    })),
  };
  const summary = formatResultContent(result, output, "summary");
  const full = formatResultContent(result, output, "full");

  assert.ok(Buffer.byteLength(summarizeResultOutput(output), "utf8") <= RESULT_SUMMARY_OUTPUT_CAP);
  assert.ok(
    Buffer.byteLength(summary, "utf8") <=
      RESULT_SUMMARY_OUTPUT_CAP + RESULT_ACTIVITY_PREVIEW_CAP + 1000,
  );
  assert.match(summary, /activity cursor: 42/);
  assert.match(full, /activity cursor: 42/);
  assert.match(summary, /recent activity:/);
  assert.match(full, /recent activity:/);
  assert.match(summary, /6 tool_end bash event-6/);
  assert.doesNotMatch(summary, /1 tool_end bash event-1/);
  const previewStart = summary.indexOf("recent activity:");
  const previewEnd = summary.indexOf("\n\nfinal output summary:");
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  assert.ok(
    Buffer.byteLength(summary.slice(previewStart, previewEnd), "utf8") <=
      RESULT_ACTIVITY_PREVIEW_CAP + 32,
  );
  assert.match(summary, /final output summary:/);
  assert.match(summary, /HEAD-/);
  assert.match(summary, /-TAIL$/);
  assert.match(full, /final output:/);
  assert.match(full, /HEAD-/);
  assert.match(full, /-TAIL$/);
  assert.ok(full.length > summary.length);
  assert.doesNotMatch(summary, /private\/sessions|private-token/);
});

test("failed and orphaned compact snapshots expose bounded one-line errors", () => {
  const error = `failure ${"x".repeat(1000)}\nsecond line`;
  for (const state of ["failed", "orphaned"]) {
    const rendered = formatCompactSnapshot(
      snapshot({
        job: { state, errorMessage: state === "failed" ? error : undefined },
        live: { errorMessage: state === "orphaned" ? error : undefined },
      }),
    );
    assert.match(rendered, new RegExp(`state=${state}`));
    assert.match(rendered, /error=failure/);
    assert.equal(rendered.split("\n").length, 1);
    assert.ok(Buffer.byteLength(rendered, "utf8") < 900);
    assert.doesNotMatch(rendered, /x{300}/);
  }
});

test("failed implementer output requires a continuation implementer", () => {
  const rendered = formatCompactSnapshot(
    snapshot({
      job: { agent: "implementer", state: "failed", errorMessage: "worker failed" },
    }),
  );
  assert.match(rendered, /continuation implementer/);
  assert.match(rendered, /parent project edits remain blocked/);
});

test("completed reviewer output routes accepted findings to remediation", () => {
  const rendered = formatCompactSnapshot(snapshot({ job: { state: "completed" } }));
  assert.match(rendered, /accepted Finding IDs to a remediation implementer/);
});

test("stats rendering includes grouped timing and action counts", () => {
  const rendered = formatStatsSummary({
    referencedJobs: 1,
    availableJobs: 1,
    parent: { usage: {} },
    child: {
      usage: {},
      timing: { queuedMs: 1000, runningMs: 2000, wallMs: 3000 },
      actions: { start: 1, wait: 2, status: 3, result: 4, failure: 5, abort: 6 },
    },
    groups: [
      {
        agent: "scout",
        model: "model-a",
        jobs: 1,
        usage: {},
        timing: { queuedMs: 1000, runningMs: 2000, wallMs: 3000 },
        actions: { start: 1, wait: 2, status: 3, result: 4, failure: 5, abort: 6 },
      },
    ],
  });
  assert.match(rendered, /queued=1s running=2s wall=3s/);
  assert.match(rendered, /scout\/model-a: jobs=1/);
  assert.match(rendered, /start=1 wait=2 status=3 result=4 failure=5 abort=6/);
});
test("usage rendering keeps cache, cost, turn, and context semantics distinct", () => {
  assert.equal(
    formatUsage({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.005,
      turns: 5,
      contextTokens: 6,
    }),
    "in 1, out 2, cache 7, cost 0.0050, turns 5, ctx 6",
  );
});
