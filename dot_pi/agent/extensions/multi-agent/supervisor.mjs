import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { releaseLease } from "./lease.mjs";
import {
  sanitizeBounded,
  serializeBoundedActivity,
  truncateUtf8,
} from "./limits.mjs";

const jobDir = process.argv[2];
if (!jobDir) throw new Error("Missing subagent job directory");

const files = {
  job: path.join(jobDir, "job.json"),
  live: path.join(jobDir, "live.json"),
  process: path.join(jobDir, "process.json"),
  launch: path.join(jobDir, "launch.json"),
  ready: path.join(jobDir, "launch.ready"),
  activity: path.join(jobDir, "activity.jsonl"),
  stderr: path.join(jobDir, "stderr.log"),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACTIVITY_EVENT_CAP = 32 * 1024;
const ACTIVITY_COMPACT_AT = 8 * 1024 * 1024;
const ACTIVITY_COMPACT_TO = 4 * 1024 * 1024;
const ACTIVITY_RETAIN_EVENTS = 2000;
const STDERR_CAP = 8 * 1024 * 1024;
const STDOUT_LINE_CAP = 4 * 1024 * 1024;

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

function procStartToken(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    if (end < 0) return undefined;
    return raw
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

async function waitForProcStartToken(pid, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let token = procStartToken(pid);
  while (!token && Date.now() < deadline) {
    await sleep(10);
    token = procStartToken(pid);
  }
  return token;
}

function truncateText(value, max = 8000) {
  return truncateUtf8(value, max);
}

function sanitize(value) {
  return sanitizeBounded(value, {
    maxDepth: 4,
    maxArray: 25,
    maxKeys: 40,
    maxStringBytes: 16 * 1024,
    maxBytes: 64 * 1024,
  });
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function resultText(result) {
  if (!result) return "";
  const content = result.content;
  return (
    truncateText(contentText(content), 64 * 1024) ||
    truncateText(JSON.stringify(sanitize(result)), 64 * 1024)
  );
}

function toolSummary(name, args) {
  const input = args && typeof args === "object" ? args : {};
  if (name === "grep") {
    const pattern = input.pattern ?? "";
    const target = input.path ?? ".";
    const glob = input.glob ? ` glob=${input.glob}` : "";
    return `/${truncateText(String(pattern), 160)}/ in ${truncateText(String(target), 240)}${glob}`;
  }
  if (name === "read") {
    const range =
      input.offset || input.limit
        ? ` offset=${input.offset ?? 1} limit=${input.limit ?? "default"}`
        : "";
    return `${truncateText(String(input.path ?? "unknown"), 320)}${range}`;
  }
  if (name === "bash") return truncateText(String(input.command ?? ""), 500);
  if (name === "find") {
    return `${truncateText(String(input.pattern ?? "*"), 160)} in ${truncateText(String(input.path ?? "."), 300)}`;
  }
  if (name === "ls") return truncateText(String(input.path ?? "."), 400);
  if (name === "edit" || name === "write")
    return truncateText(String(input.path ?? "unknown"), 400);
  return truncateText(JSON.stringify(sanitize(args)), 500);
}

async function findSession(sessionDir) {
  try {
    const entries = await fs.promises.readdir(sessionDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const candidate = path.join(sessionDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return candidate;
      if (entry.isDirectory()) {
        const nested = await findSession(candidate);
        if (nested) return nested;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

let job = await readJson(files.job);
let live = await readJson(files.live);
let launch;
let child;
let childOutcome;
let childClosed = true;
let abortRequested = false;
let finalizationPromise;
let finalOutcome;
let finalized = false;
let forceKillTimer;
let liveTimer;
let discardingOversizedLine = false;
let stderrBytes = (() => {
  try {
    return fs.statSync(files.stderr).size;
  } catch {
    return 0;
  }
})();
let writeChain = Promise.resolve();

function enqueue(operation) {
  writeChain = writeChain.then(operation, operation);
  return writeChain;
}

async function writeJob(patch) {
  job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await atomicWriteJson(files.job, job);
}

async function flushLive() {
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = undefined;
  }
  live.updatedAt = new Date().toISOString();
  await atomicWriteJson(files.live, live);
}

function scheduleLive() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = undefined;
    enqueue(flushLive);
  }, 100);
}

async function compactActivityLog() {
  let stat;
  try {
    stat = await fs.promises.stat(files.activity);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.size <= ACTIVITY_COMPACT_AT) return;

  const lines = (await fs.promises.readFile(files.activity, "utf8"))
    .split("\n")
    .filter(Boolean);
  const retained = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineBytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (
      retained.length >= ACTIVITY_RETAIN_EVENTS ||
      retainedBytes + lineBytes > ACTIVITY_COMPACT_TO
    ) {
      break;
    }
    retained.unshift(lines[index]);
    retainedBytes += lineBytes;
  }
  const temporary = `${files.activity}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(
    temporary,
    retained.length ? `${retained.join("\n")}\n` : "",
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.promises.rename(temporary, files.activity);
}

async function appendActivity(type, fields = {}) {
  const timestamp = new Date().toISOString();
  live.activitySeq += 1;
  live.lastEventAt = timestamp;
  const event = {
    seq: live.activitySeq,
    timestamp,
    type,
    ...fields,
  };
  const serialized = serializeBoundedActivity(event, ACTIVITY_EVENT_CAP);
  await fs.promises.appendFile(files.activity, `${serialized}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (live.activitySeq % 100 === 0) await compactActivityLog();
  return event;
}

async function updateSessionPath() {
  if (job.sessionPath) return;
  const sessionPath = await findSession(job.sessionDir);
  if (sessionPath) await writeJob({ sessionPath });
}

function addUsage(message) {
  const usage = message?.usage;
  if (!usage) return;
  live.usage.input += usage.input || 0;
  live.usage.output += usage.output || 0;
  live.usage.cacheRead += usage.cacheRead || 0;
  live.usage.cacheWrite += usage.cacheWrite || 0;
  live.usage.cost += usage.cost?.total || 0;
  live.usage.contextTokens = usage.totalTokens || 0;
  live.usage.turns += 1;
}

async function handleEvent(event) {
  const now = new Date().toISOString();
  live.lastEventAt = now;

  if (event.type === "session") {
    await updateSessionPath();
    await appendActivity("session", {
      summary: `session ${event.id ?? job.id}`,
    });
    live.activity = "session started";
    await flushLive();
    return;
  }

  if (event.type === "tool_execution_start") {
    live.currentTool = {
      id: event.toolCallId,
      name: event.toolName,
      arguments: sanitize(event.args),
      summary: toolSummary(event.toolName, event.args),
      startedAt: now,
    };
    live.activity = `tool: ${event.toolName} ${live.currentTool.summary}`;
    await appendActivity("tool_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      summary: live.currentTool.summary,
      data: sanitize(event.args),
    });
    await flushLive();
    return;
  }

  if (event.type === "tool_execution_update") {
    if (live.currentTool?.id === event.toolCallId) {
      live.currentTool.partialResult = sanitize(event.partialResult);
    }
    scheduleLive();
    return;
  }

  if (event.type === "tool_execution_end") {
    const summary = resultText(event.result);
    live.latestToolResult = summary;
    await appendActivity("tool_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      summary: truncateText(
        summary || (event.isError ? "tool failed" : "tool completed"),
        1000,
      ),
      data: { isError: Boolean(event.isError) },
    });
    if (live.currentTool?.id === event.toolCallId) live.currentTool = undefined;
    live.activity = event.isError
      ? `tool failed: ${event.toolName}`
      : "thinking";
    await flushLive();
    return;
  }

  if (event.type === "message_update" && event.message?.role === "assistant") {
    live.partialAssistantOutput = truncateText(
      contentText(event.message.content),
      64 * 1024,
    );
    scheduleLive();
    return;
  }

  if (event.type === "message_end" && event.message) {
    const message = event.message;
    const text = truncateText(contentText(message.content), 64 * 1024);
    if (message.role === "assistant") {
      if (text) live.latestCompletedOutput = text;
      live.partialAssistantOutput = undefined;
      live.stopReason = message.stopReason;
      live.errorMessage = message.errorMessage;
      addUsage(message);
      await appendActivity("assistant_message", {
        summary: truncateText(
          text || `assistant ${message.stopReason ?? "message"}`,
          1000,
        ),
      });
    } else if (message.role === "toolResult") {
      if (text) live.latestToolResult = text;
      await appendActivity("tool_result", {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        summary: truncateText(text || "tool result", 1000),
        data: { isError: Boolean(message.isError) },
      });
    }
    live.activity =
      message.role === "assistant" && message.stopReason === "toolUse"
        ? "dispatching tool"
        : "thinking";
    await flushLive();
    return;
  }

  if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
    await appendActivity(event.type, {
      summary: truncateText(
        event.errorMessage ||
          event.finalError ||
          `attempt ${event.attempt ?? ""}`,
        1000,
      ),
      data: sanitize(event),
    });
    live.activity = event.type === "auto_retry_start" ? "retrying" : "thinking";
    await flushLive();
    return;
  }

  if (event.type === "compaction_start" || event.type === "compaction_end") {
    await appendActivity(event.type, {
      summary: `${event.reason ?? "unknown"}${event.aborted ? " aborted" : ""}`,
    });
    live.activity =
      event.type === "compaction_start" ? "compacting" : "thinking";
    await flushLive();
    return;
  }

  if (event.type === "agent_end") {
    await appendActivity("agent_end", { summary: "agent finished" });
    live.activity = "finishing";
    await flushLive();
  }
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(files.ready)) {
    if (Date.now() >= deadline)
      throw new Error("Supervisor launch was not acknowledged");
    await sleep(25);
  }
}

function killChildGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
}

async function applyAbortRequest() {
  const now = new Date().toISOString();
  live.state = "aborting";
  live.activity = "aborting";
  await writeJob({ state: "aborting", abortRequestedAt: now });
  await appendActivity("abort_requested", { summary: "SIGTERM requested" });
  await flushLive();
  killChildGroup("SIGTERM");
  forceKillTimer = setTimeout(() => {
    if (!childClosed) killChildGroup("SIGKILL");
  }, 5000);
}

function queueAbortRequest() {
  if (abortRequested) return;
  abortRequested = true;
  enqueue(applyAbortRequest);
}

async function terminateChildAfterFailure() {
  if (!child || childClosed) return;
  killChildGroup("SIGTERM");
  const graceful = await Promise.race([
    childOutcome.then(() => true),
    sleep(5000).then(() => false),
  ]);
  if (!graceful && !childClosed) {
    killChildGroup("SIGKILL");
    await Promise.race([childOutcome, sleep(1000)]);
  }
}

process.on("SIGTERM", queueAbortRequest);
process.on("SIGINT", queueAbortRequest);
process.on("exit", () => {
  if (child && !childClosed) killChildGroup("SIGKILL");
});

async function finalize(exitCode, spawnError) {
  if (finalized) return;
  if (!finalOutcome) finalOutcome = { exitCode, spawnError };
  if (finalizationPromise) return finalizationPromise;
  finalizationPromise = (async () => {
    const outcome = finalOutcome;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    await writeChain;
    await flushLive();
    await updateSessionPath();

    const stopReason = live.stopReason;
    let state;
    if (abortRequested || stopReason === "aborted") state = "aborted";
    else if (
      !outcome.spawnError &&
      outcome.exitCode === 0 &&
      stopReason !== "error"
    )
      state = "completed";
    else state = "failed";

    const now = new Date().toISOString();
    const errorMessage = outcome.spawnError?.message || live.errorMessage;
    live.state = state;
    live.activity = state;
    live.errorMessage = errorMessage;
    live.currentTool = undefined;
    await appendActivity(state, {
      summary: errorMessage || `exit ${outcome.exitCode ?? 1}`,
      data: { exitCode: outcome.exitCode ?? 1, stopReason },
    });
    await flushLive();
    await writeJob({
      state,
      endedAt: now,
      exitCode: outcome.exitCode ?? 1,
      stopReason,
      errorMessage,
    });
    let leaseError;
    for (const lease of [...(job.leases ?? [])].reverse()) {
      try {
        await releaseLease(lease);
      } catch (error) {
        leaseError ??= error;
        console.error(
          `Failed to release ${lease.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (leaseError) throw leaseError;
    finalized = true;
  })();
  try {
    await finalizationPromise;
  } finally {
    finalizationPromise = undefined;
  }
}

try {
  await waitForReady();
  await writeChain;

  if (abortRequested) {
    await finalize(143);
  } else {
    launch = await readJson(files.launch);
    const startedAt = new Date().toISOString();
    live.state = "running";
    live.activity = "starting";
    live.lastEventAt = startedAt;
    await writeJob({ state: "running", startedAt });
    await appendActivity("started", {
      summary: `${job.agent} using ${job.model}`,
    });
    await flushLive();

    if (abortRequested) {
      throw new Error("Subagent launch was aborted before child spawn");
    }
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...launch.env },
    });
    childClosed = false;
    childOutcome = new Promise((resolve) => {
      let spawnError;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code) => {
        childClosed = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        resolve({ code: code ?? 1, error: spawnError });
      });
    });

    const processRecord = await readJson(files.process);
    await atomicWriteJson(files.process, {
      ...processRecord,
      childPid: child.pid,
      childStartToken: await waitForProcStartToken(child.pid),
      updatedAt: new Date().toISOString(),
    });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      let text = chunk.toString();
      if (discardingOversizedLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        discardingOversizedLine = false;
        text = text.slice(newline + 1);
      }
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (Buffer.byteLength(buffer, "utf8") > STDOUT_LINE_CAP) {
        buffer = "";
        discardingOversizedLine = true;
        enqueue(() =>
          appendActivity("event_oversized", {
            summary: `JSON event exceeded ${STDOUT_LINE_CAP} bytes and was discarded`,
          }),
        );
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > STDOUT_LINE_CAP) {
          enqueue(() =>
            appendActivity("event_oversized", {
              summary: `JSON event exceeded ${STDOUT_LINE_CAP} bytes and was discarded`,
            }),
          );
          continue;
        }
        enqueue(async () => {
          try {
            await handleEvent(JSON.parse(line));
          } catch (error) {
            await appendActivity("event_parse_error", {
              summary: truncateText(
                error instanceof Error ? error.message : String(error),
                1000,
              ),
            });
          }
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= STDERR_CAP) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = buffer.subarray(0, STDERR_CAP - stderrBytes);
        fs.appendFileSync(files.stderr, retained, { mode: 0o600 });
        stderrBytes += retained.length;
      } catch {
        // A logging failure must not leave the detached child unsupervised.
      }
    });

    const outcome = await childOutcome;
    if (buffer.trim()) {
      try {
        await enqueue(() => handleEvent(JSON.parse(buffer)));
      } catch {
        // Ignore a final incomplete JSON event.
      }
    }
    await finalize(outcome.code, outcome.error);
  }
} catch (error) {
  await terminateChildAfterFailure();
  await finalize(1, error instanceof Error ? error : new Error(String(error)));
}
