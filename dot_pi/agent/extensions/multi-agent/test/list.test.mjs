import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { procStartToken } from "../lease.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(rootDir, "index.ts");
const supervisorPath = path.join(rootDir, "supervisor.mjs");

test("list keeps old active jobs visible and offers paged, filtered history", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-list-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const jobRoot = path.join(root, "agent", "subagent-sessions");
  const activeId = "list-old-active";
  for (let index = 0; index < 8; index += 1) {
    const id = index === 0 ? activeId : `list-finished-${index}`;
    const jobDir = path.join(jobRoot, id);
    const sessionDir = path.join(jobDir, "sessions");
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const createdAt = `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
    const state = index === 0 ? "running" : "completed";
    await fs.promises.writeFile(path.join(jobDir, "job.json"), JSON.stringify({
      version: 1, id, agent: index % 2 ? "reviewer" : "scout", task: id,
      mode: "research", model: "test/model", state, cwd: root,
      sourceRoot: root, jobDir, sessionDir, createdAt, startedAt: createdAt,
      updatedAt: createdAt, ...(state === "completed" ? { endedAt: createdAt } : {}),
    }));
    await fs.promises.writeFile(path.join(jobDir, "live.json"), JSON.stringify({
      jobId: id, state, updatedAt: createdAt, lastEventAt: createdAt,
      activitySeq: 0, activity: state,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    }));
  }
  const activeDir = path.join(jobRoot, activeId);
  const fakeSupervisor = spawn(process.execPath, [
    "-e", "setInterval(() => {}, 0x7fffffff)", "--", supervisorPath, activeDir,
  ], { stdio: "ignore" });
  t.after(async () => {
    if (fakeSupervisor.exitCode === null && fakeSupervisor.signalCode === null) {
      const exited = once(fakeSupervisor, "exit");
      fakeSupervisor.kill("SIGTERM");
      await exited;
    }
  });
  await once(fakeSupervisor, "spawn");
  assert.ok(fakeSupervisor.pid);
  const token = procStartToken(fakeSupervisor.pid);
  assert.ok(token);
  await fs.promises.writeFile(path.join(activeDir, "process.json"), JSON.stringify({
    jobId: activeId, supervisorPid: fakeSupervisor.pid, supervisorStartToken: token,
    phase: "supervisor", updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const output = path.join(root, "output.json");
  const driver = path.join(root, "driver.ts");
  await fs.promises.writeFile(driver, `
import * as fs from "node:fs";
import * as path from "node:path";
import multiAgent from ${JSON.stringify(indexPath)};
const jobRoot = ${JSON.stringify(jobRoot)};
const activeId = ${JSON.stringify(activeId)};
let tool;
let command;
multiAgent({ on() {}, registerTool(value) { tool = value; },
  registerCommand(name, value) { if (name === "agent-jobs") command = value; } });
const notices = [];
const ctx = { hasUI: true, ui: { notify(text) { notices.push(text); } } };
const invoke = async (params) => (await tool.execute("list", { action: "list", ...params }, undefined, undefined, ctx)).details.jobs.map((s) => s.job.id);
const defaults = await invoke({});
const history = await invoke({ history: true });
const filtered = await invoke({ history: true, agent: "reviewer", state: "completed", limit: 2, offset: 1 });
const session = await invoke({ session: path.join(jobRoot, activeId, "sessions") });
await command.handler("list", ctx);
await command.handler("list history state=completed limit=2 offset=1", ctx);
await command.handler("list state=invalid", ctx);
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ defaults, history, filtered, session, notices }));
`);
  const result = spawnSync("pi", ["--no-extensions", "--extension", driver, "--list-models"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" },
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(await fs.promises.readFile(output, "utf8"));
  assert.deepEqual(data.defaults, [activeId, "list-finished-7", "list-finished-6", "list-finished-5", "list-finished-4", "list-finished-3"]);
  assert.equal(data.history.length, 8);
  assert.deepEqual(data.filtered, ["list-finished-5", "list-finished-3"]);
  assert.deepEqual(data.session, [activeId]);
  assert.match(data.notices[0], /list-old-active/);
  assert.doesNotMatch(data.notices[0], /list-finished-1/);
  assert.match(data.notices[1], /list-finished-6/);
  assert.match(data.notices[2], /Invalid list option/);
});
