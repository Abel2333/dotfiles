import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_STREAM_BYTES = 24 * 1024;
const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const MAX_COMMAND_BYTES = 100_000;
const WORKER = fileURLToPath(new URL("./kernel.py", import.meta.url));

class OutputCapture {
  constructor(id) {
    this.marker = Buffer.from(`\x1e${id}\x1f`);
    this.tail = Buffer.alloc(0);
    this.output = Buffer.alloc(0);
    this.done = false;
    this.truncated = false;
  }

  retain(data) {
    const remaining = MAX_STREAM_BYTES - this.output.length;
    if (data.length > remaining) this.truncated = true;
    this.output = Buffer.concat([this.output, data.subarray(0, remaining)]);
  }

  push(data) {
    if (this.done) return;
    const joined = Buffer.concat([this.tail, data]);
    const end = joined.indexOf(this.marker);
    if (end >= 0) {
      this.retain(joined.subarray(0, end));
      this.tail = Buffer.alloc(0);
      this.done = true;
      return;
    }
    const boundary = Math.max(0, joined.length - this.marker.length + 1);
    this.retain(joined.subarray(0, boundary));
    this.tail = joined.subarray(boundary);
  }

  text() {
    return this.output.toString("utf8") + (this.truncated ? "\n[Output truncated; excess discarded.]" : "");
  }
}

/**
 * Own one lazy uv Python kernel. No processes start in the constructor.
 * Options select a dedicated uv project and injectable timers for deterministic
 * deadline tests. Never use this class as a sandbox; it executes approved code.
 */
export class PythonKernel {
  constructor({ project = join(homedir(), "Tools", "pyenvs", "pi-python-repl"), clock = globalThis } = {}) {
    this.project = project;
    this.clock = clock;
    this.child = undefined;
    this.pending = undefined;
    this.frame = Buffer.alloc(0);
    this.generation = 0;
    this.reason = "Not started. Previous session memory is not restored.";
    this.variables = [];
    this.history = [];
    this.sequence = 0;
  }

  /** Return cached metadata without starting Python or evaluating user objects. */
  status() {
    return {
      running: Boolean(this.child), busy: Boolean(this.pending),
      project: this.project, interpreter: this.interpreter ?? null,
      pid: this.workerPid ?? null, cwd: this.cwd ?? null,
      generation: this.generation, reason: this.reason,
      variables: this.variables.map((item) => ({ ...item })),
      history: this.history.map((item) => ({ ...item })),
    };
  }

  start(cwd) {
    if (process.platform === "win32") throw new Error("Python REPL currently requires POSIX process groups.");
    if (!existsSync(join(this.project, ".venv", "bin", "python"))) {
      throw new Error(`Missing uv environment: ${this.project}. Follow python-repl/README.md setup.`);
    }
    const env = { ...process.env, MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1" };
    // An inherited UV_PROJECT_ENVIRONMENT or VIRTUAL_ENV must never redirect
    // this tool into a different project or the system interpreter.
    for (const key of Object.keys(env)) {
      if (key.startsWith("UV_") || key === "VIRTUAL_ENV" || key.startsWith("PYTHON")) delete env[key];
    }
    const child = spawn("uv", [
      "--no-config", "run", "--project", this.project, "--offline", "--no-sync",
      "python", "-I", "-u", WORKER, this.project,
    ], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.child = child;
    this.frame = Buffer.alloc(0);
    this.cwd = cwd;
    this.reason = "Kernel starting; globals are fresh.";
    child.stdout.on("data", (data) => {
      if (this.child !== child) return;
      this.pending?.stdout.push(data);
      this.complete();
    });
    child.stderr.on("data", (data) => {
      if (this.child !== child) return;
      this.pending?.stderr.push(data);
      this.complete();
    });
    child.stdio[3].on("data", (data) => {
      if (this.child !== child) return;
      try {
        this.frame = Buffer.concat([this.frame, data]);
        if (this.frame.length > MAX_FRAME_BYTES) throw new Error("Kernel reply exceeds 6 MiB");
        let end;
        while ((end = this.frame.indexOf(10)) >= 0) {
          const message = JSON.parse(this.frame.subarray(0, end).toString("utf8"));
          this.frame = this.frame.subarray(end + 1);
          if (message.ready === true) {
            this.interpreter = message.interpreter;
            this.workerPid = message.pid;
          } else if (this.pending && message.id === this.pending.id) {
            this.pending.reply = message;
            this.complete();
          } else {
            throw new Error("Unexpected kernel reply");
          }
        }
      } catch (error) {
        void this.reset(`Protocol failure: ${error.message}`);
      }
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) void this.reset(`Kernel input failed: ${error.message}`);
    });
    child.stdio[3].on("error", (error) => {
      if (this.child === child) void this.reset(`Kernel protocol failed: ${error.message}`);
    });
    child.once("error", (error) => {
      if (this.child === child) void this.reset(`Cannot start uv: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) void this.reset(`Kernel exited (${signal ?? code}).`);
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
  }

  complete() {
    const pending = this.pending;
    if (!pending?.reply || !pending.stdout.done || !pending.stderr.done) return;
    const reply = pending.reply;
    if (!Array.isArray(reply.variables) || !Array.isArray(reply.images) || reply.images.length > 4 ||
        reply.images.some((image) => typeof image !== "string" || image.length > 1_398_104) ||
        typeof reply.value !== "string" || reply.value.length > 8192) {
      void this.reset("Invalid kernel result.");
      return;
    }
    this.pending = undefined;
    pending.cleanup();
    this.variables = reply.variables.slice(0, 100);
    this.cwd = reply.cwd;
    this.sequence += 1;
    this.history.push({ execution: this.sequence, outcome: reply.error ?? "ok" });
    this.history = this.history.slice(-20);
    this.reason = reply.error ? "Execution failed; partial changes to globals remain." : "Ready; globals retained.";
    pending.resolve({
      ...reply, stdout: pending.stdout.text(), stderr: pending.stderr.text(),
      truncated: pending.stdout.truncated || pending.stderr.truncated,
      execution: this.sequence,
    });
  }

  /**
   * Execute source in the live namespace and return captured output and PNGs.
   * cwd is used at first launch; os.chdir persists until reset. Timeout seconds
   * includes startup. Abort, exit and protocol errors reject and discard memory.
   * Concurrent requests reject; callers must serialize executions.
   */
  async exec(command, { cwd = process.cwd(), timeout = 30, signal } = {}) {
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
      throw new Error("command must be nonempty Python source of at most 100000 UTF-8 bytes.");
    }
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) throw new Error("timeout must be 1..600 seconds.");
    if (signal?.aborted) throw new Error("Python execution cancelled before starting; globals unchanged.");
    if (this.pending) throw new Error("Python kernel is busy; wait for execution to finish or reset it.");
    if (this.stopping) await this.stopping;
    if (signal?.aborted) throw new Error("Python execution cancelled before starting; globals unchanged.");
    if (this.pending) throw new Error("Python kernel is busy; wait for execution to finish or reset it.");
    if (!this.child) this.start(cwd);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { void this.reset("Python execution cancelled."); };
      const timer = this.clock.setTimeout(() => { void this.reset(`Python execution timed out after ${timeout}s.`); }, timeout * 1000);
      this.pending = {
        id, resolve, reject, stdout: new OutputCapture(id), stderr: new OutputCapture(id),
        cleanup: () => {
          this.clock.clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, command }) + "\n");
    });
  }

  /**
   * Kill the uv process group, reject any pending request and forget globals.
   * Idempotently await process exit; no Python shutdown code is executed.
   */
  async reset(reason = "Manual reset.") {
    if (this.stopping) return this.stopping;
    const child = this.child;
    const pending = this.pending;
    this.child = undefined;
    this.pending = undefined;
    this.variables = [];
    this.history = [];
    this.interpreter = undefined;
    this.workerPid = undefined;
    this.cwd = undefined;
    this.sequence = 0;
    this.frame = Buffer.alloc(0);
    this.reason = `${reason} Python memory cleared; code was not replayed. Files and external effects are not undone.`;
    this.generation += 1;
    pending?.cleanup();
    this.stopping = (async () => {
      try {
        if (child?.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        if (child && child.exitCode === null && child.signalCode === null && child.pid) await this.exited;
      } finally {
        for (const stream of child?.stdio ?? []) stream?.destroy();
        pending?.reject(new Error(this.reason));
      }
    })();
    try { await this.stopping; }
    finally { this.stopping = undefined; }
  }
}
