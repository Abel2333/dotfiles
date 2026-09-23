import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, watch, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PythonKernel } from "../runtime.mjs";

function kernel(t, options) {
  const instance = new PythonKernel(options);
  t.after(() => instance.reset("Test cleanup."));
  return instance;
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-python-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("lazily starts the uv interpreter and preserves globals and last result", async (t) => {
  const k = kernel(t);
  assert.equal(k.status().running, false);
  assert.equal((await k.exec("x = 40\nx + 2")).value, "42");
  assert.equal((await k.exec("x += 1\n(x, _)")).value, "(41, 42)");
  const status = k.status();
  assert.match(status.interpreter, /Tools\/pyenvs\/pi-python-repl\/\.venv\/bin\/python/);
  assert.deepEqual(status.variables, [{ name: "x", type: "int" }]);
  assert.equal(status.history.length, 2);
  assert.equal(status.project, join(homedir(), "Tools", "pyenvs", "pi-python-repl"));
});

test("isolates kernels even when they use the same uv environment", async (t) => {
  const first = kernel(t);
  const second = kernel(t);
  await first.exec("secret_value = 7");
  assert.equal((await second.exec("'secret_value' in globals()")).value, "False");
  assert.notEqual(first.status().pid, second.status().pid);
});

test("captures Python and native stdout/stderr without corrupting replies", async (t) => {
  const k = kernel(t);
  const result = await k.exec("import os, sys\nprint('python-out')\nprint('python-err', file=sys.stderr)\nos.write(1, b'native-out\\n')\nos.write(2, b'native-err\\n')\n42");
  assert.equal(result.stdout, "python-out\nnative-out\n");
  assert.equal(result.stderr, "python-err\nnative-err\n");
  assert.equal(result.value, "42");
});

test("retains partial state after exceptions and rejects syntax before execution", async (t) => {
  const k = kernel(t);
  const failure = await k.exec("x = 8\nprint('before-error')\nraise ValueError('example')");
  assert.equal(failure.error, "ValueError");
  assert.match(failure.stderr, /ValueError: example/);
  assert.equal(failure.stdout, "before-error\n");
  assert.equal((await k.exec("x")).value, "8");
  assert.equal((await k.exec("x = 9\nif")).error, "SyntaxError");
  assert.equal((await k.exec("x")).value, "8");
  assert.equal((await k.exec("raise SystemExit(0)")).error, "SystemExit");
  assert.equal((await k.exec("2 + 2")).value, "4");
});

test("bounds stdout, stderr and execution history while continuing to drain pipes", async (t) => {
  const k = kernel(t);
  const output = await k.exec("import os\nfor i in range(100):\n    os.write(1, b'x' * 10000)\n    os.write(2, b'y' * 10000)\n'finished'");
  assert.equal(output.value, "'finished'");
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout) < 25 * 1024);
  assert.ok(Buffer.byteLength(output.stderr) < 25 * 1024);
  assert.match(output.stdout, /excess discarded/);
  for (let i = 0; i < 21; i += 1) await k.exec("None");
  assert.equal(k.status().history.length, 20);
});

test("returns valid matplotlib PNGs and closes figures between calls", async (t) => {
  const k = kernel(t);
  const result = await k.exec("import matplotlib.pyplot as plt\nplt.plot([0, 1, 2], [0, 1, 4]); plt.title('Example')");
  assert.equal(result.error, null);
  assert.equal(result.images.length, 1);
  assert.equal(Buffer.from(result.images[0], "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await k.exec("plt.get_fignums()")).value, "[]");
  assert.equal((await k.exec("1")).images.length, 0);
});

test("supports explicit PNG display and rejects oversized or excess images", async (t) => {
  const k = kernel(t);
  const png = "from PIL import Image\nimport io\nb = io.BytesIO()\nImage.new('RGB', (1, 1)).save(b, format='PNG')\ndata = b.getvalue()";
  assert.equal((await k.exec(png + "\ndisplay_png(data)")).images.length, 1);
  const excess = await k.exec("for i in range(5): display_png(data)");
  assert.equal(excess.error, "ValueError");
  assert.equal(excess.images.length, 4);
  const oversized = await k.exec("display_png(b'x' * (1024 * 1024 + 1))");
  assert.equal(oversized.error, "ValueError");
  assert.equal(oversized.images.length, 0);
});

test("status uses cached names and types without repr or property evaluation", async (t) => {
  const k = kernel(t);
  await k.exec("class Trap:\n    def __repr__(self): raise RuntimeError('repr executed')\nt = Trap()\nNone");
  assert.ok(k.status().variables.some((item) => item.name === "t" && item.type === "Trap"));
  const copy = k.status();
  copy.variables.length = 0;
  assert.ok(k.status().variables.length > 0);
});

test("manual reset clears globals and a later exec starts fresh", async (t) => {
  const k = kernel(t);
  await k.exec("value = 23");
  const pid = k.status().pid;
  await k.reset();
  assert.equal(k.status().running, false);
  assert.deepEqual(k.status().variables, []);
  assert.match(k.status().reason, /memory cleared/);
  assert.equal((await k.exec("'value' in globals()")).value, "False");
  assert.notEqual(k.status().pid, pid);
});

test("fake deadline kills the actual worker and invalidates globals", async (t) => {
  let fire;
  const clock = { setTimeout(callback, milliseconds) { assert.equal(milliseconds, 30000); fire = callback; return 1; }, clearTimeout() {} };
  const k = kernel(t, { clock });
  await k.exec("value = 23");
  const pid = k.status().pid;
  const pending = k.exec("while True: pass");
  const rejected = assert.rejects(pending, /timed out.*memory cleared/s);
  fire();
  await rejected;
  assert.equal(k.status().running, false);
  try {
    const state = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.equal(state.split(") ")[1][0], "Z", "worker must be gone or a reaped-pending zombie");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.equal((await k.exec("'value' in globals()")).value, "False");
});

test("abort after a file handshake stops a running cell without replay", async (t) => {
  const root = await temporaryDirectory(t);
  const k = kernel(t);
  const controller = new AbortController();
  const marker = join(root, "ready");
  const watcher = watch(root);
  const ready = (async () => {
    for await (const event of watcher) {
      if (event.filename === "ready") return;
    }
  })();
  const pending = k.exec(`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ready')\nwhile True: pass`, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled.*memory cleared/s);
  await ready;
  controller.abort();
  await rejected;
  await watcher.return();
  assert.equal(k.status().running, false);
  await access(marker);
});

test("pre-aborted calls and concurrent calls cannot change existing state", async (t) => {
  const k = kernel(t);
  await k.exec("x = 3");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(k.exec("x = 9", { signal: controller.signal }), /unchanged/);
  assert.equal((await k.exec("x")).value, "3");
  const pending = k.exec("while True: pass");
  const rejected = assert.rejects(pending, /memory cleared/);
  await assert.rejects(k.exec("x = 4"), /busy/);
  await k.reset();
  await rejected;
});

test("input has EOF instead of consuming protocol requests and future flags persist", async (t) => {
  const k = kernel(t);
  assert.equal((await k.exec("input('prompt')")).error, "EOFError");
  await k.exec("from __future__ import annotations");
  assert.equal((await k.exec("def f(x: Unknown): pass\nf.__annotations__")).value, "{'x': 'Unknown'}");
});

test("crashed worker is reported and its namespace is not silently reused", async (t) => {
  const k = kernel(t);
  await assert.rejects(k.exec("import os\nx = 3\nos._exit(9)"), /Kernel exited.*memory cleared/s);
  assert.equal(k.status().running, false);
  assert.equal((await k.exec("'x' in globals()")).value, "False");
});

test("validates requests without starting a process", async (t) => {
  const k = kernel(t);
  for (const command of ["", " ", "x".repeat(100001)]) await assert.rejects(k.exec(command), /command/);
  await assert.rejects(k.exec("1", { timeout: 0 }), /timeout/);
  assert.equal(k.status().running, false);
});
