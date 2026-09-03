import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { procStartToken } from "../lease.mjs";

const EXTENSION_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const INDEX_PATH = path.join(EXTENSION_ROOT, "index.ts");
const JOBS_PATH = path.join(EXTENSION_ROOT, "jobs.ts");
const RUNNER_PATH = path.join(EXTENSION_ROOT, "runner.ts");
const WORKSPACE_PATH = path.join(EXTENSION_ROOT, "workspace.ts");
const SUPERVISOR_PATH = path.join(EXTENSION_ROOT, "supervisor.mjs");

function processRunning(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    return (
      raw
        .slice(end + 2)
        .trim()
        .split(/\s+/)[0] !== "Z"
    );
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  return new Promise((resolve) => child.once("close", resolve));
}

async function runDriver(root, source) {
  const driver = path.join(root, `driver-${Date.now()}-${Math.random()}.ts`);
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

async function createOrphanFixture(root, name) {
  const agentDir = path.join(root, "agent");
  const id = `${name}-0000-0000-0000-000000000000`;
  const jobDir = path.join(agentDir, "subagent-sessions", id);
  const sessionDir = path.join(jobDir, "sessions");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const marker = path.join(jobDir, "child.pid");
  const now = new Date().toISOString();
  await fs.promises.writeFile(
    path.join(jobDir, "job.json"),
    `${JSON.stringify({
      version: 1,
      id,
      agent: "scout",
      task: name,
      mode: "research",
      model: "test/model",
      state: "queued",
      cwd: root,
      sourceRoot: root,
      jobDir,
      sessionDir,
      createdAt: now,
      updatedAt: now,
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "live.json"),
    `${JSON.stringify({
      jobId: id,
      state: "queued",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: 0,
      activity: "queued",
      usage: emptyUsage(),
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "launch.json"),
    `${JSON.stringify({
      jobId: id,
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
        "--",
        "--session-id",
        id,
      ],
      cwd: root,
      env: {},
    })}\n`,
  );
  const log = await fs.promises.open(path.join(jobDir, "test.log"), "a");
  const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, jobDir], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  await new Promise((resolve, reject) => {
    supervisor.once("spawn", resolve);
    supervisor.once("error", reject);
  });
  await fs.promises.writeFile(
    path.join(jobDir, "process.json"),
    `${JSON.stringify({
      jobId: id,
      supervisorPid: supervisor.pid,
      supervisorStartToken: procStartToken(supervisor.pid),
      updatedAt: now,
    })}\n`,
  );
  await fs.promises.writeFile(path.join(jobDir, "launch.ready"), "ready\n");
  const processRecord = await waitFor(async () => {
    try {
      const value = JSON.parse(
        await fs.promises.readFile(path.join(jobDir, "process.json"), "utf8"),
      );
      return value.childPid ? value : undefined;
    } catch {
      return undefined;
    }
  });
  await waitFor(() => fs.existsSync(marker));
  process.kill(supervisor.pid, "SIGKILL");
  await waitForProcess(supervisor);
  await log.close();
  return { id, jobDir, processRecord, childPid: processRecord.childPid };
}

test("Pi-loaded integration boundaries", { concurrency: 1 }, async (t) => {
  await t.test("multi-agent extension module loads under pi", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-load-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    await runDriver(
      root,
      `import ${JSON.stringify(INDEX_PATH)};\nexport default async function() {}`,
    );
  });

  await t.test(
    "workspace lease blocks cleanup until explicitly released",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-workspace-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { prepareWorkspace, cleanupWorkspace, releasePreparedWorkspaceLease } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const workspace=await prepareWorkspace("scratch",${JSON.stringify(root)},"test",undefined,"job-1"); let blocked=false; try { await cleanupWorkspace(workspace.record.id); } catch { blocked=true; } await releasePreparedWorkspaceLease(workspace); const cleaned=await cleanupWorkspace(workspace.record.id); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({blocked,exists:fs.existsSync(cleaned.path)})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.deepEqual(result, { blocked: true, exists: false });
    },
  );

  await t.test(
    "a crashed workspace preparation remains registered and recoverable",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-workspace-crash-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "workspace.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { prepareWorkspace } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const workspace=await prepareWorkspace("scratch",${JSON.stringify(root)},"test",undefined,"job-crashed"); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(workspace.record)); }\n`,
      );
      const record = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(fs.existsSync(record.path), true);
      const cleanedOutput = path.join(root, "cleaned.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { cleanupWorkspace } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const record=await cleanupWorkspace(${JSON.stringify(record.id)},{canRecoverLease:async()=>true}); fs.writeFileSync(${JSON.stringify(cleanedOutput)},JSON.stringify({exists:fs.existsSync(record.path)})); }\n`,
      );
      assert.deepEqual(
        JSON.parse(await fs.promises.readFile(cleanedOutput, "utf8")),
        { exists: false },
      );
    },
  );

  await t.test("feasibility lease acquisition is atomic", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-feas-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const output = path.join(root, "result.json");
    await runDriver(
      root,
      `import * as fs from "node:fs";\nimport { acquireFeasibilityLease, releaseUnstartedLease } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const first=await acquireFeasibilityLease("job-1"); let blocked=false; try { await acquireFeasibilityLease("job-2"); } catch { blocked=true; } await releaseUnstartedLease(first); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({blocked})); }\n`,
    );
    assert.deepEqual(JSON.parse(await fs.promises.readFile(output, "utf8")), {
      blocked: true,
    });
  });

  await t.test(
    "startJob hands leases to the Supervisor and releases them after spawn failure",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-start-failure-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "result.json");
      const guardPath = path.join(EXTENSION_ROOT, "child-guard.ts");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { acquireFeasibilityLease, createJobId, startJob, waitForJob } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const id=createJobId(); const lease=await acquireFeasibilityLease(id); const snapshot=await startJob({id,config:{name:"feasibility",description:"test",systemPrompt:"test",filePath:"test"},task:{agent:"feasibility",task:"test",workspace:"research"},model:"invalid/model",workspace:{mode:"research",cwd:path.join(${JSON.stringify(root)},"missing"),sourceRoot:${JSON.stringify(root)}},feasibilityLease:lease,guardPath:${JSON.stringify(guardPath)}}); const final=await waitForJob(snapshot.job.id,10); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({state:final.job.state,leaseExists:fs.existsSync(lease.path)})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.state, "failed");
      assert.equal(result.leaseExists, false);
    },
  );

  await t.test("orphan recovery terminates a verified child", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-orphan-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const fixture = await createOrphanFixture(root, "orphan");
    t.after(() => {
      if (processRunning(fixture.childPid))
        process.kill(-fixture.childPid, "SIGKILL");
    });
    const output = path.join(root, "result.json");
    await runDriver(
      root,
      `import * as fs from "node:fs";\nimport { getJobSnapshot } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const snapshot=await getJobSnapshot(${JSON.stringify(fixture.id)}); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(snapshot)); }\n`,
    );
    const snapshot = JSON.parse(await fs.promises.readFile(output, "utf8"));
    await waitFor(() => !processRunning(fixture.childPid));
    assert.equal(snapshot.job.state, "orphaned");
  });

  await t.test(
    "unverified child identity is not signalled and blocks cleanup",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-unverified-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const fixture = await createOrphanFixture(root, "unverified");
      t.after(() => {
        if (processRunning(fixture.childPid))
          process.kill(-fixture.childPid, "SIGKILL");
      });
      const processPath = path.join(fixture.jobDir, "process.json");
      const record = JSON.parse(
        await fs.promises.readFile(processPath, "utf8"),
      );
      delete record.childStartToken;
      await fs.promises.writeFile(processPath, `${JSON.stringify(record)}\n`);
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { cleanupJob, getJobSnapshot } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const snapshot=await getJobSnapshot(${JSON.stringify(fixture.id)}); let cleanupBlocked=false; try { await cleanupJob(${JSON.stringify(fixture.id)}); } catch { cleanupBlocked=true; } fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({snapshot,cleanupBlocked})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.snapshot.childIdentity, "unverified");
      assert.equal(result.cleanupBlocked, true);
      assert.equal(processRunning(fixture.childPid), true);
    },
  );

  await t.test(
    "large final output is streamed, bounded, and keeps head and tail",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-result-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const agentDir = path.join(root, "agent");
      const id = "result-0000-0000-0000-000000000000";
      const jobDir = path.join(agentDir, "subagent-sessions", id);
      const sessionDir = path.join(jobDir, "sessions");
      await fs.promises.mkdir(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "session.jsonl");
      const now = new Date().toISOString();
      const finalText = `HEAD-${"中🙂".repeat(100000)}-TAIL`;
      await fs.promises.writeFile(
        sessionPath,
        `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "job.json"),
        `${JSON.stringify({ version: 1, id, agent: "scout", task: "result", mode: "research", model: "test/model", state: "completed", cwd: root, sourceRoot: root, jobDir, sessionDir, sessionPath, createdAt: now, updatedAt: now, endedAt: now })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "live.json"),
        `${JSON.stringify({ jobId: id, state: "completed", updatedAt: now, lastEventAt: now, activitySeq: 1000, activity: "completed", usage: emptyUsage() })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "activity.jsonl"),
        `${Array.from({ length: 1000 }, (_, index) => JSON.stringify({ seq: index + 1, timestamp: now, type: "test", summary: `event-${index + 1}` })).join("\n")}\n`,
      );
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { getJobResult } from ${JSON.stringify(JOBS_PATH)};\nimport { truncateOutput } from ${JSON.stringify(RUNNER_PATH)};\nexport default async function(){ const result=await getJobResult(${JSON.stringify(id)},0,10); const bounded=truncateOutput(result.finalOutput); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({rawBytes:Buffer.byteLength(result.finalOutput,"utf8"),boundedBytes:Buffer.byteLength(bounded,"utf8"),bounded,hasMessages:Object.hasOwn(result,"messages"),activityCount:result.activities.length,nextCursor:result.nextCursor})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.ok(result.rawBytes <= 256 * 1024);
      assert.ok(result.boundedBytes <= 128 * 1024);
      assert.match(result.bounded, /^HEAD-/);
      assert.match(result.bounded, /-TAIL$/);
      assert.equal(result.hasMessages, false);
      assert.equal(result.activityCount, 10);
      assert.equal(result.nextCursor, 10);
    },
  );
});
