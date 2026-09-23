import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const EXTENSION_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const INDEX_PATH = path.join(EXTENSION_ROOT, "index.ts");

function usage(input, output, cacheRead, cacheWrite, cost, contextTokens, turns) {
  return { input, output, cacheRead, cacheWrite, cost, contextTokens, turns };
}

async function createCompletedJob(root, id, agent, model, output, liveUsage) {
  const agentDir = path.join(root, "agent");
  const jobDir = path.join(agentDir, "subagent-sessions", id);
  const sessionDir = path.join(jobDir, "sessions");
  const sessionPath = path.join(sessionDir, "session.jsonl");
  const now = "2026-01-01T00:00:00.000Z";
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
      },
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "job.json"),
    `${JSON.stringify({
      version: 1,
      id,
      agent,
      task: `Task for ${id}`,
      summary: `Summary for ${id}`,
      mode: "research",
      model,
      state: "completed",
      cwd: root,
      sourceRoot: root,
      jobDir,
      sessionDir,
      sessionPath,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      endedAt: now,
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "live.json"),
    `${JSON.stringify({
      jobId: id,
      state: "completed",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: 1,
      activity: "completed",
      usage: liveUsage,
    })}\n`,
  );
  return { jobDir, sessionPath };
}

async function runDriver(root, source) {
  const driver = path.join(root, "runtime-driver.ts");
  await fs.promises.writeFile(driver, source);
  const result = spawnSync(
    "pi",
    ["--no-extensions", "--extension", driver, "--list-models"],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("public subagent handlers expose compact results, wait_many, stats, and preflight", { concurrency: 1 }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-runtime-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const firstId = "runtime-first-0000-0000-0000-000000000000";
  const secondId = "runtime-second-0000-0000-0000-000000000000";
  const output = `HEAD-${"x".repeat(300_000)}-TAIL`;
  const first = await createCompletedJob(
    root,
    firstId,
    "scout",
    "model-a",
    output,
    usage(7, 8, 9, 10, 1.5, 111, 2),
  );
  await createCompletedJob(
    root,
    secondId,
    "reviewer",
    "model-b",
    "SECOND",
    usage(20, 30, 40, 50, 2.5, 222, 3),
  );
  const resultPath = path.join(root, "result.json");
  const source = `
import * as fs from "node:fs";
import multiAgent from ${JSON.stringify(INDEX_PATH)};
const firstId = ${JSON.stringify(firstId)};
const secondId = ${JSON.stringify(secondId)};
const resultPath = ${JSON.stringify(resultPath)};
let registeredTool;
multiAgent({
  on() {},
  registerTool(tool) { registeredTool = tool; },
  registerCommand() {},
});
const toolEntry = (id, action, jobs) => ({
  type: "message",
  id,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "toolResult",
    toolName: "subagent",
    content: [],
    details: { action, jobs: jobs.map((jobId) => ({ job: { id: jobId } })) },
  },
});
const branch = [
  {
    type: "message",
    id: "parent-usage",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      usage: {
        input: 100,
        output: 200,
        cacheRead: 300,
        cacheWrite: 400,
        totalTokens: 500,
        cost: { total: 3.5 },
      },
    },
  },
  toolEntry("start", "start", [firstId]),
  toolEntry("status", "status", [firstId]),
  toolEntry("wait", "wait", [firstId, secondId]),
  toolEntry("result", "result", [firstId]),
];
const ctx = {
  cwd: ${JSON.stringify(root)},
  hasUI: false,
  model: { provider: "test", id: "parent" },
  ui: { confirm: async () => false },
  sessionManager: { getBranch: () => branch },
};
const text = (result) => result.content.find((item) => item.type === "text")?.text ?? "";
const status = await registeredTool.execute("status", { action: "status", jobId: firstId }, undefined, undefined, ctx);
const summary = await registeredTool.execute("summary", { action: "result", jobId: firstId }, undefined, undefined, ctx);
const full = await registeredTool.execute("full", { action: "result", jobId: firstId, view: "full" }, undefined, undefined, ctx);
const singleWait = await registeredTool.execute("wait", { action: "wait", jobId: firstId, waitSeconds: 300, stallSeconds: 0 }, undefined, undefined, ctx);
const zeroWait = await registeredTool.execute("wait-zero", { action: "wait", jobId: firstId, waitSeconds: 0, stallSeconds: 0 }, undefined, undefined, ctx);
let updateCount = 0;
const manyWait = await registeredTool.execute("many", { action: "wait_many", jobIds: [firstId, firstId, secondId] }, undefined, () => { updateCount += 1; }, ctx);
const stats = await registeredTool.execute("stats", { action: "stats" }, undefined, undefined, ctx);
const jobsRoot = ${JSON.stringify(path.join(root, "agent", "subagent-sessions"))};
const beforeMissingModel = fs.readdirSync(jobsRoot).sort();
let missingModel = "";
try {
  await registeredTool.execute("missing-model", {
    action: "start",
    agent: "scout",
    task: "Inspect the repository without changing files.",
    summary: "Missing model",
  }, undefined, undefined, ctx);
} catch (error) {
  missingModel = error instanceof Error ? error.message : String(error);
}
let blankModel = "";
try {
  await registeredTool.execute("blank-model", {
    action: "start",
    agent: "scout",
    task: "Inspect the repository without changing files.",
    summary: "Blank model",
    model: "   ",
  }, undefined, undefined, ctx);
} catch (error) {
  blankModel = error instanceof Error ? error.message : String(error);
}
const afterMissingModel = fs.readdirSync(jobsRoot).sort();
const beforePreflight = fs.readdirSync(jobsRoot).sort();
let preflight = "";
try {
  await registeredTool.execute("preflight", {
    action: "start",
    agent: "implementer",
    task: "Please run git commit -m finish after testing.",
    summary: "Commit work",
    model: "test/parent",
  }, undefined, undefined, ctx);
} catch (error) {
  preflight = error instanceof Error ? error.message : String(error);
}
const afterPreflight = fs.readdirSync(jobsRoot).sort();
fs.writeFileSync(resultPath, JSON.stringify({
  schema: JSON.stringify(registeredTool.parameters),
  statusText: text(status),
  statusSessionPath: status.details.jobs[0].job.sessionPath,
  summaryText: text(summary),
  fullText: text(full),
  resultOutput: summary.details.resultOutput,
  summaryDetailsBytes: Buffer.byteLength(JSON.stringify(summary.details), "utf8"),
  singleWait: singleWait.details.observation,
  zeroWait: zeroWait.details.observation,
  manyWait: manyWait.details.observation,
  manyJobs: manyWait.details.jobs.map((snapshot) => snapshot.job.id),
  updateCount,
  statsText: text(stats),
  stats: stats.details.stats,
  statsHasUsage: Object.hasOwn(stats, "usage"),
  missingModel,
  blankModel,
  beforeMissingModel,
  afterMissingModel,
  preflight,
  beforePreflight,
  afterPreflight,
}));
`;
  await runDriver(root, source);
  const result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));

  assert.match(result.schema, /wait_many/);
  assert.match(result.schema, /stallSeconds/);
  assert.match(result.schema, /jobIds/);
  assert.match(result.schema, /"summary"/);
  assert.match(result.schema, /"full"/);
  assert.match(result.schema, /stats/);
  const schema = JSON.parse(result.schema);
  assert.ok(schema.properties.tasks.items.required.includes("model"));
  assert.ok(!(schema.required ?? []).includes("model"));
  assert.doesNotMatch(result.statusText, /sessions|sessionPath/);
  assert.equal(result.statusSessionPath, first.sessionPath);
  assert.match(result.summaryText, /final output summary:/);
  assert.match(result.summaryText, /HEAD-/);
  assert.match(result.summaryText, /-TAIL$/);
  assert.doesNotMatch(result.summaryText, /sessions/);
  assert.ok(result.fullText.length > result.summaryText.length);
  assert.match(result.resultOutput, /HEAD-/);
  assert.match(result.resultOutput, /-TAIL$/);
  assert.ok(result.summaryDetailsBytes <= 256 * 1024);
  assert.deepEqual(result.singleWait, {
    reason: "terminal",
    stalledJobIds: [],
    pendingApprovalJobIds: [],
    waitSeconds: 600,
    stallSeconds: 0,
  });
  assert.deepEqual(result.zeroWait, {
    reason: "terminal",
    stalledJobIds: [],
    pendingApprovalJobIds: [],
    waitSeconds: 600,
    stallSeconds: 0,
  });
  assert.deepEqual(result.manyWait, {
    reason: "terminal",
    stalledJobIds: [],
    pendingApprovalJobIds: [],
    waitSeconds: 1200,
    stallSeconds: 1200,
  });
  assert.deepEqual(result.manyJobs, [firstId, secondId]);
  assert.equal(result.updateCount, 1);
  assert.match(result.statsText, /Subagent stats: 2\/2 retained job\(s\) from this active branch\./);
  assert.equal(result.stats.child.usage.input, 27);
  assert.equal(result.stats.child.usage.turns, 5);
  assert.equal(result.stats.parent.usage.input, 100);
  assert.equal(result.statsHasUsage, false);
  assert.match(result.missingModel, /requires an explicit model/);
  assert.equal(result.blankModel, result.missingModel);
  assert.deepEqual(result.afterMissingModel, result.beforeMissingModel);
  assert.match(result.preflight, /cannot request Git mutation/);
  assert.deepEqual(result.afterPreflight, result.beforePreflight);
});

test("public result handlers retain activity cursors and terminal errors", { concurrency: 1 }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-result-content-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const completedId = "content-completed-0000-0000-0000-000000000000";
  const failedId = "content-failed-0000-0000-0000-000000000000";
  const completed = await createCompletedJob(
    root,
    completedId,
    "scout",
    "model",
    "HEAD-output-TAIL",
    usage(1, 2, 3, 4, 0.5, 5, 6),
  );
  const now = "2026-01-01T00:00:00.000Z";
  await fs.promises.writeFile(
    path.join(completed.jobDir, "activity.jsonl"),
    `${JSON.stringify({ seq: 1, timestamp: now, type: "tool_start", toolName: "bash", summary: "git status" })}\n${JSON.stringify({ seq: 2, timestamp: now, type: "assistant_message", summary: "verified result" })}\n`,
  );
  const failed = await createCompletedJob(
    root,
    failedId,
    "reviewer",
    "model",
    "FAILED-output",
    usage(7, 8, 9, 10, 1.5, 11, 12),
  );
  const error = `worker failure ${"x".repeat(1000)}\nsecond line`;
  const failedJobPath = path.join(failed.jobDir, "job.json");
  const failedJob = JSON.parse(await fs.promises.readFile(failedJobPath, "utf8"));
  failedJob.state = "failed";
  failedJob.errorMessage = error;
  await fs.promises.writeFile(failedJobPath, `${JSON.stringify(failedJob)}\n`);
  const failedLivePath = path.join(failed.jobDir, "live.json");
  const failedLive = JSON.parse(await fs.promises.readFile(failedLivePath, "utf8"));
  failedLive.state = "failed";
  failedLive.errorMessage = error;
  await fs.promises.writeFile(failedLivePath, `${JSON.stringify(failedLive)}\n`);

  const resultPath = path.join(root, "result-content.json");
  await runDriver(
    root,
    `
import * as fs from "node:fs";
import multiAgent from ${JSON.stringify(INDEX_PATH)};
const completedId = ${JSON.stringify(completedId)};
const failedId = ${JSON.stringify(failedId)};
const resultPath = ${JSON.stringify(resultPath)};
let registeredTool;
multiAgent({
  on() {},
  registerTool(tool) { registeredTool = tool; },
  registerCommand() {},
});
const ctx = {
  cwd: ${JSON.stringify(root)},
  hasUI: false,
  model: { provider: "test", id: "parent" },
  ui: { confirm: async () => false },
  sessionManager: { getBranch: () => [] },
};
const text = (result) => result.content.find((item) => item.type === "text")?.text ?? "";
const summary = await registeredTool.execute("summary", { action: "result", jobId: completedId }, undefined, undefined, ctx);
const full = await registeredTool.execute("full", { action: "result", jobId: completedId, view: "full" }, undefined, undefined, ctx);
const failedStatus = await registeredTool.execute("failed-status", { action: "status", jobId: failedId }, undefined, undefined, ctx);
const failedResult = await registeredTool.execute("failed-result", { action: "result", jobId: failedId }, undefined, undefined, ctx);
fs.writeFileSync(resultPath, JSON.stringify({
  summaryText: text(summary),
  fullText: text(full),
  failedStatusText: text(failedStatus),
  failedResultText: text(failedResult),
}));
`,
  );
  const result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));

  for (const text of [result.summaryText, result.fullText]) {
    assert.match(text, /activity cursor: 2/);
    assert.match(text, /recent activity:\n1 tool_start bash git status/);
    assert.match(text, /2 assistant_message verified result/);
    assert.match(text, /HEAD-output-TAIL$/);
  }
  assert.match(result.failedStatusText, /state=failed/);
  assert.match(result.failedStatusText, /error=worker failure/);
  assert.equal(result.failedStatusText.split("\n").length, 1);
  assert.ok(Buffer.byteLength(result.failedStatusText, "utf8") < 900);
  assert.doesNotMatch(result.failedStatusText, /x{300}/);
  assert.match(result.failedResultText, /error=worker failure/);
});

// Tool registration is the session-wide exposure path: every new session that
// loads the extension receives these promptGuidelines.
test("registered subagent tool exposes delegation-first prompt guidelines", { concurrency: 1 }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-guidelines-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, "agent"), { recursive: true });
  const resultPath = path.join(root, "guidelines.json");
  await runDriver(
    root,
    `
import * as fs from "node:fs";
import multiAgent from ${JSON.stringify(INDEX_PATH)};
const resultPath = ${JSON.stringify(resultPath)};
let registeredTool;
multiAgent({
  on() {},
  registerTool(tool) { registeredTool = tool; },
  registerCommand() {},
});
fs.writeFileSync(resultPath, JSON.stringify({
  guidelines: registeredTool.promptGuidelines,
}));
`,
  );
  const result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));
  assert.ok(Array.isArray(result.guidelines));
  const delegationDefault = result.guidelines.find(
    (line) => /action=start/.test(line) && /prefer a subagent/.test(line),
  );
  assert.ok(
    delegationDefault,
    "a guideline must route non-trivial repository work to subagent action=start",
  );
  assert.match(delegationDefault, /non-trivial repository work/);
  assert.match(delegationDefault, /narrow tasks direct/);
  const noDuplicate = result.guidelines.find((line) =>
    /do not duplicate broad exploration/i.test(line),
  );
  assert.ok(noDuplicate, "a guideline must forbid duplicate exploration");
  assert.match(noDuplicate, /action=wait/);
  assert.match(noDuplicate, /action=result/);
  assert.match(noDuplicate, /parent read\/bash/);
});

test("parent guard defaults to strict and agent-mode exposes the direct escape", { concurrency: 1 }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-parent-mode-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await createCompletedJob(
    root,
    "review-job",
    "reviewer",
    "model-a",
    "review output",
    usage(1, 2, 3, 4, 0.5, 10, 1),
  );
  const resultPath = path.join(root, "parent-mode.json");
  await runDriver(
    root,
    `
import * as fs from "node:fs";
import multiAgent from ${JSON.stringify(INDEX_PATH)};
process.env.PI_MULTI_AGENT_ROLE = "";
let toolHandler;
const commands = {};
const notices = [];
multiAgent({
  on(name, handler) { if (name === "tool_call") toolHandler = handler; },
  registerTool() {},
  registerCommand(name, command) { commands[name] = command; },
});
let branch = [
  { type: "message", id: "user", message: { role: "user", content: "review" } },
  { type: "message", id: "start", message: { role: "toolResult", toolCallId: "review-start", toolName: "subagent", details: { action: "start", jobs: [{ job: { id: "review-job", agent: "reviewer", state: "completed" } }] } } },
];
const ctx = {
  cwd: ${JSON.stringify(root)},
  ui: { notify(message, level) { notices.push({ message, level }); } },
  sessionManager: { getBranch() { return branch; } },
};
const strict = await toolHandler({ toolName: "edit", input: { path: "src/file.ts" } }, ctx);
const plansWrite = (await toolHandler({ toolName: "write", input: { path: "plans/note.md" } }, ctx)) ?? null;
await commands["agent-mode"].handler("", ctx);
await commands["agent-mode"].handler("direct", ctx);
const direct = await toolHandler({ toolName: "edit", input: { path: "src/file.ts" } }, ctx);
await commands["agent-mode"].handler("strict", ctx);
branch = [
  { type: "message", id: "feasibility-user", message: { role: "user", content: "check" } },
  { type: "message", id: "feasibility-start", message: { role: "toolResult", toolCallId: "feasibility-start", toolName: "subagent", details: { action: "start", jobs: [{ job: { id: "feasibility-job", agent: "feasibility", state: "completed" } }] } } },
];
const explorationCalls = [];
for (let index = 0; index < 5; index += 1) {
  const outcome = await toolHandler({ toolName: "read", input: { path: "src/file.ts" } }, ctx);
  explorationCalls.push(outcome ?? null);
}
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
  commandNames: Object.keys(commands).sort(),
  strict,
  plansWrite,
  direct: direct ?? null,
  explorationCalls,
  notices,
}));
`,
  );
  const result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));
  assert.ok(result.commandNames.includes("agent-mode"));
  assert.equal(result.strict.block, true);
  assert.equal(result.plansWrite, null);
  assert.equal(result.direct, null);
  assert.deepEqual(result.explorationCalls.slice(0, 4), [null, null, null, null]);
  assert.equal(result.explorationCalls[4]?.block, true);
  assert.match(result.explorationCalls[4].reason, /targeted scout/i);
  assert.match(result.notices[0].message, /Parent agent mode: strict/);
  assert.match(result.notices[1].message, /set to direct/);
});
