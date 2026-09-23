import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateParentToolCall } from "../../multi-agent/parent-guard.mjs";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const agentRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function driver(t, source, configure) {
  const root = await mkdtemp(join(tmpdir(), "pi-python-driver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await configure?.(root, agentDir);
  const output = join(root, "result.json");
  const file = join(root, "driver.ts");
  await writeFile(file, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n${source}\nfs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ ok: true }));\nexport default function() {}\n`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_MULTI_AGENT_") || key.startsWith("PI_SECURITY_")) delete env[key];
  const result = spawnSync("pi", ["--no-extensions", "--extension", file, "--list-models"], { env, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  let data;
  try { data = JSON.parse(await readFile(output, "utf8")); }
  catch { assert.fail(`Driver did not complete: ${result.stderr}\n${result.stdout}`); }
  assert.equal(data.ok, true);
}

function workflow(state = "completed") {
  return [
    { type: "message", message: { role: "user", content: "work" } },
    { type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "start", details: { action: "start", jobs: [{ job: { id: "job", agent: "implementer", state } }] } } },
  ];
}

test("Python cannot bypass active-job or completed-workflow execution restrictions", async () => {
  for (const state of ["running", "completed", "failed"]) {
    const event = { toolName: "python", input: { action: "exec", command: "open('file', 'w').write('x')" } };
    const result = await evaluateParentToolCall(event, { branch: workflow(state), env: {} });
    assert.equal(result?.block, true, state);
    assert.equal(await evaluateParentToolCall(event, { branch: workflow(state), env: {}, mode: "direct" }), undefined);
  }
});

test("security gate confirms the exact Python source; status and reset stay quiet", async (t) => {
  await driver(t, `
import { registerGate } from ${JSON.stringify(resolve(agentRoot, "extensions/security/gate.ts"))};
let gate;
registerGate({ on(name, handler) { if (name === 'tool_call') gate = handler; } });
const source = "result = 6 * 7";
let approvals = 0;
let allow = false;
const ctx = {
  cwd: ${JSON.stringify(tmpdir())}, hasUI: true,
  sessionManager: { getEntries() { return []; } },
  ui: { theme: { bold: x => x, fg: (_color, x) => x }, notify() {}, async confirm(_title, message) { approvals++; assert.ok(message.includes(source)); return allow; } },
};
assert.equal((await gate({ toolName: 'python', input: { action: 'exec', command: source } }, ctx))?.block, true);
allow = true;
assert.equal(await gate({ toolName: 'python', input: { action: 'exec', command: source } }, ctx), undefined);
for (const action of ['status', 'reset']) assert.equal(await gate({ toolName: 'python', input: { action } }, ctx), undefined);
assert.equal(approvals, 2);
assert.equal((await gate({ toolName: 'python', input: { action: 'exec', command: source } }, { ...ctx, hasUI: false }))?.block, true);
`, async (_root, agentDir) => {
    await copyFile(resolve(agentRoot, "security-rules.toml"), join(agentDir, "security-rules.toml"));
  });
});

test("Pi loads the real tool and lifecycle hooks preserve or clear state as specified", async (t) => {
  await driver(t, `
import extension from ${JSON.stringify(extension)};
let tool;
const hooks = new Map();
extension({ registerTool(value) { tool = value; }, on(name, handler) { hooks.set(name, handler); } });
assert.equal(tool.name, 'python');
assert.equal(tool.executionMode, 'sequential');
let session = 'first';
const ctx = { cwd: ${JSON.stringify(tmpdir())}, sessionManager: { getSessionId: () => session } };
const run = (params) => tool.execute('test', params, undefined, undefined, ctx);
try {
  assert.equal((await run({ action: 'status' })).details.running, false);
  await run({ action: 'exec', command: 'value = 42' });
  hooks.get('session_compact')();
  assert.match(hooks.get('before_agent_start')().message.content, /not been reset/);
  assert.match((await run({ action: 'exec', command: 'value' })).content[0].text, /42/);
  await hooks.get('session_tree')();
  assert.equal((await run({ action: 'status' })).details.running, false);
  assert.match(hooks.get('before_agent_start')().message.content, /memory cleared/);
  await assert.rejects(run({ action: 'exec', command: 'value' }), /NameError/);
  await run({ action: 'exec', command: 'value = 9' });
  session = 'second';
  assert.equal((await run({ action: 'status' })).details.running, false);
  await run({ action: 'exec', command: 'value = 1' });
  await hooks.get('session_shutdown')({ reason: 'reload' });
  assert.equal((await run({ action: 'status' })).details.running, false);
  const image = await run({ action: 'exec', command: 'import matplotlib.pyplot as plt\\nplt.plot([0, 1], [0, 1])' });
  assert.equal(image.content[1].type, 'image');
  assert.equal(image.content[1].mimeType, 'image/png');
  const lines = await run({ action: 'exec', command: "print('x\\\\n' * 10000)" });
  assert.ok(lines.content[0].text.split('\\n').length <= 2000);
  assert.ok(Buffer.byteLength(lines.content[0].text) <= 50 * 1024);
  process.env.PI_MULTI_AGENT_ROLE = 'scout';
  await assert.rejects(run({ action: 'exec', command: '1' }), /not enabled for delegated agents/);
  delete process.env.PI_MULTI_AGENT_ROLE;
} finally { await hooks.get('session_shutdown')({ reason: 'quit' }); }
`);
});
