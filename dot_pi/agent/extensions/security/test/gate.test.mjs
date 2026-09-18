import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SECURITY_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const GATE_PATH = path.join(SECURITY_ROOT, "gate.ts");
const APPROVAL_PATH = path.join(SECURITY_ROOT, "approval.ts");

async function runDriver(root, source, env = {}) {
  const driver = path.join(root, `driver-${Date.now()}-${Math.random()}.ts`);
  await fs.promises.writeFile(driver, source);
  const result = spawnSync(
    "pi",
    ["--no-extensions", "--extension", driver, "--list-models"],
    {
      env: {
        ...process.env,
        HOME: path.join(root, "isolated-home"),
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_OFFLINE: "1",
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fakeContext(cwd) {
  return `{
    cwd: ${JSON.stringify(cwd)},
    hasUI: false,
    signal: new AbortController().signal,
    ui: { notify() {} },
    sessionManager: { getEntries() { return []; } },
  }`;
}

test("security gate loads rules and logs from the configured agent directory", async (t) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-security-gate-path-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await fs.promises.mkdir(agentDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(agentDir, "security-rules.toml"),
    '[[bash]]\nname = "deny-echo"\ncmd = "echo"\ndecision = "deny"\nreason = "blocked by configured rule"\n',
  );
  const output = path.join(root, "result.json");

  await runDriver(
    root,
    `import * as fs from "node:fs";
import { registerGate } from ${JSON.stringify(GATE_PATH)};
let handler;
registerGate({ on(name, value) { if (name === "tool_call") handler = value; } });
const result = await handler({ toolName: "bash", input: { command: "echo hello" } }, ${fakeContext(root)});
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
export default function() {}`,
  );

  const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
  assert.equal(result.block, true);
  assert.match(result.reason, /configured rule/);
  const log = await fs.promises.readFile(
    path.join(agentDir, "logs", "security.log"),
    "utf8",
  );
  assert.match(log, /deny-echo/);
  assert.equal(
    fs.existsSync(
      path.join(root, "isolated-home", ".pi", "agent", "security-rules.toml"),
    ),
    false,
  );
});

test("headless implementer ask waits for a bound parent response", async (t) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-security-gate-approval-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const approvalDir = path.join(root, "approvals");
  await fs.promises.mkdir(agentDir, { recursive: true });
  await fs.promises.mkdir(approvalDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(agentDir, "security-rules.toml"),
    '[[bash]]\nname = "ask-echo"\ncmd = "echo"\ndecision = "ask"\nreason = "confirm echo"\n',
  );
  const output = path.join(root, "result.json");

  await runDriver(
    root,
    `import * as fs from "node:fs";
import { registerGate } from ${JSON.stringify(GATE_PATH)};
import { listPendingApprovals, resolveApprovalRequest } from ${JSON.stringify(APPROVAL_PATH)};
const approvalDir = ${JSON.stringify(approvalDir)};
let handler;
registerGate({ on(name, value) { if (name === "tool_call") handler = value; } });
const observed = new Promise((resolve, reject) => {
  const watcher = fs.watch(approvalDir, (_event, file) => {
    if (file?.toString().endsWith(".request.json")) { watcher.close(); resolve(); }
  });
  watcher.on("error", reject);
});
const pendingResult = handler({ toolName: "bash", input: { command: "echo hello" } }, ${fakeContext(root)});
await observed;
const [request] = await listPendingApprovals(approvalDir);
await resolveApprovalRequest(approvalDir, request.id, request.jobId, "allow");
const result = await pendingResult;
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ result: result ?? null, pending: await listPendingApprovals(approvalDir) }));
export default function() {}`,
    {
      PI_MULTI_AGENT_JOB_ID: "job-approval",
      PI_MULTI_AGENT_ROLE: "implementer",
      PI_SECURITY_APPROVAL_DIR: approvalDir,
      PI_SECURITY_LOG_DIR: path.join(root, "job-security-logs"),
      PI_SECURITY_POLICY_HOME: "/home/original-user",
    },
  );

  const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
  assert.equal(result.result, null);
  assert.deepEqual(result.pending, []);
  const log = await fs.promises.readFile(
    path.join(root, "job-security-logs", "security.log"),
    "utf8",
  );
  assert.match(log, /parent-approved/);
});
