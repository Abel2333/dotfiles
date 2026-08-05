import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireLease,
  leaseReference,
  procStartToken,
  releaseLease,
  transferLease,
} from "../lease.mjs";

const EXTENSION_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const SUPERVISOR_PATH = path.join(EXTENSION_ROOT, "supervisor.mjs");
const NODE = process.execPath;

function usage() {
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

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function waitForSupervisor(supervisor) {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
    return supervisor.exitCode;
  }
  return new Promise((resolve) => supervisor.once("close", resolve));
}

async function createFixture(root, name, childCode, options = {}) {
  const id = `${name}-0000-0000-0000-000000000000`;
  const jobDir = path.join(root, id);
  const sessionDir = path.join(jobDir, "sessions");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  let lease;
  if (options.withLease) {
    lease = await acquireLease(path.join(jobDir, "job.lock"), {
      name: `job:${id}`,
      jobId: id,
    });
  }
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
      leases: lease ? [leaseReference(lease)] : [],
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "live.json"),
    `${JSON.stringify({
      jobId: id,
      state: "queued",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: options.activitySeq ?? 0,
      activity: "queued",
      usage: usage(),
    })}\n`,
  );
  if (options.activityBytes) {
    const line = `${JSON.stringify({ seq: 1, timestamp: now, type: "existing", summary: "x".repeat(1000) })}\n`;
    const count = Math.ceil(options.activityBytes / Buffer.byteLength(line));
    await fs.promises.writeFile(
      path.join(jobDir, "activity.jsonl"),
      line.repeat(count),
    );
  }
  await fs.promises.writeFile(
    path.join(jobDir, "launch.json"),
    `${JSON.stringify({
      jobId: id,
      command: NODE,
      args: ["-e", childCode, "--", "--session-id", id],
      cwd: root,
      env: {},
    })}\n`,
  );
  const logHandle = await fs.promises.open(path.join(jobDir, "test.log"), "a");
  const supervisor = spawn(NODE, [SUPERVISOR_PATH, jobDir], {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  await new Promise((resolve, reject) => {
    supervisor.once("spawn", resolve);
    supervisor.once("error", reject);
  });
  if (lease) {
    await transferLease(lease, {
      ownerPid: supervisor.pid,
      ownerStartToken: procStartToken(supervisor.pid),
      phase: "supervisor",
    });
  }
  await fs.promises.writeFile(
    path.join(jobDir, "process.json"),
    `${JSON.stringify({
      jobId: id,
      supervisorPid: supervisor.pid,
      supervisorStartToken: procStartToken(supervisor.pid),
      updatedAt: now,
    })}\n`,
  );
  return { id, jobDir, lease, logHandle, supervisor };
}

async function terminateFixture(fixture) {
  const processRecord = await readJson(
    path.join(fixture.jobDir, "process.json"),
  );
  for (const pid of [processRecord?.childPid, fixture.supervisor.pid]) {
    if (!pid || !processRunning(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await fixture.logHandle.close();
  if (fixture.lease) {
    try {
      await releaseLease(leaseReference(fixture.lease));
    } catch {
      // The Supervisor may already have released it.
    }
  }
}

test("Supervisor lifecycle and limits", { concurrency: 1 }, async (t) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-ma-supervisor-"),
  );
  const fixtures = [];
  t.after(async () => {
    for (const fixture of fixtures) await terminateFixture(fixture);
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  await t.test(
    "normal completion persists terminal state and releases leases",
    async () => {
      const fixture = await createFixture(
        root,
        "normal",
        `console.log(JSON.stringify({type:"agent_end"}));`,
        { withLease: true },
      );
      fixtures.push(fixture);
      await fs.promises.writeFile(
        path.join(fixture.jobDir, "launch.ready"),
        "ready\n",
      );
      assert.equal(await waitForSupervisor(fixture.supervisor), 0);
      const job = await readJson(path.join(fixture.jobDir, "job.json"));
      assert.equal(job.state, "completed");
      assert.equal(fs.existsSync(fixture.lease.path), false);
    },
  );

  await t.test(
    "SIGTERM terminates the child and retains an aborted job",
    async () => {
      const fixture = await createFixture(
        root,
        "sigterm",
        `setInterval(()=>{},1000);`,
      );
      fixtures.push(fixture);
      await fs.promises.writeFile(
        path.join(fixture.jobDir, "launch.ready"),
        "ready\n",
      );
      const record = await waitFor(async () => {
        const value = await readJson(path.join(fixture.jobDir, "process.json"));
        return value?.childPid ? value : undefined;
      });
      process.kill(fixture.supervisor.pid, "SIGTERM");
      await waitForSupervisor(fixture.supervisor);
      await waitFor(() => !processRunning(record.childPid));
      const job = await readJson(path.join(fixture.jobDir, "job.json"));
      assert.equal(job.state, "aborted");
    },
  );

  await t.test("abort before ready never spawns the child", async () => {
    const marker = path.join(root, "preabort-marker");
    const fixture = await createFixture(
      root,
      "preabort",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
    );
    fixtures.push(fixture);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(fixture.supervisor.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.promises.writeFile(
      path.join(fixture.jobDir, "launch.ready"),
      "ready\n",
    );
    await waitForSupervisor(fixture.supervisor);
    assert.equal(fs.existsSync(marker), false);
    const job = await readJson(path.join(fixture.jobDir, "job.json"));
    assert.equal(job.state, "aborted");
  });

  await t.test(
    "post-spawn initialization failure cleans the child",
    async () => {
      const marker = path.join(root, "fault-marker");
      const fixture = await createFixture(
        root,
        "initfault",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
      );
      fixtures.push(fixture);
      await fs.promises.writeFile(
        path.join(fixture.jobDir, "process.json"),
        "{broken",
      );
      await fs.promises.writeFile(
        path.join(fixture.jobDir, "launch.ready"),
        "ready\n",
      );
      await waitForSupervisor(fixture.supervisor);
      const job = await readJson(path.join(fixture.jobDir, "job.json"));
      assert.equal(job.state, "failed");
      if (fs.existsSync(marker)) {
        const childPid = Number(await fs.promises.readFile(marker, "utf8"));
        await waitFor(() => !processRunning(childPid));
      }
    },
  );

  await t.test(
    "activity logs compact after crossing the disk cap",
    async () => {
      const fixture = await createFixture(
        root,
        "activity-compact",
        `console.log(JSON.stringify({type:"agent_end"}));`,
        { activitySeq: 99, activityBytes: 9 * 1024 * 1024 },
      );
      fixtures.push(fixture);
      await fs.promises.writeFile(
        path.join(fixture.jobDir, "launch.ready"),
        "ready\n",
      );
      await waitForSupervisor(fixture.supervisor);
      const activity = await fs.promises.stat(
        path.join(fixture.jobDir, "activity.jsonl"),
      );
      assert.ok(activity.size <= 4 * 1024 * 1024 + 32 * 1024);
    },
  );

  await t.test("oversized event data and stderr are bounded", async () => {
    const childCode = `const value="x".repeat(2*1024*1024);console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"1",toolName:"bash",args:{command:value}}));process.stderr.write(Buffer.alloc(9*1024*1024,120));`;
    const fixture = await createFixture(root, "limits", childCode);
    fixtures.push(fixture);
    await fs.promises.writeFile(
      path.join(fixture.jobDir, "launch.ready"),
      "ready\n",
    );
    await waitForSupervisor(fixture.supervisor);
    const activity = await fs.promises.readFile(
      path.join(fixture.jobDir, "activity.jsonl"),
      "utf8",
    );
    for (const line of activity.trim().split("\n")) {
      assert.ok(Buffer.byteLength(line, "utf8") <= 32 * 1024);
      assert.doesNotThrow(() => JSON.parse(line));
    }
    const stderr = await fs.promises.stat(
      path.join(fixture.jobDir, "stderr.log"),
    );
    assert.ok(stderr.size <= 8 * 1024 * 1024);
  });
});
