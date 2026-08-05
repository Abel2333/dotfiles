import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  acquireLease,
  leaseReference,
  releaseLease,
  transferLease,
} from "./lease.mjs";
import { truncateUtf8 } from "./limits.mjs";
import { prepareAgentLaunch } from "./runner";
import type {
  ActivityEvent,
  AgentConfig,
  DelegatedTask,
  JobLiveSnapshot,
  JobResultSnapshot,
  JobSnapshot,
  JobState,
  LaunchConfig,
  LeaseHandle,
  LeaseReference,
  PreparedWorkspace,
  ProcessIdentityState,
  ProcessRecord,
  SubagentJobRecord,
  UsageStats,
} from "./types";
import { TERMINAL_JOB_STATES } from "./types";

const AGENT_DIR = getAgentDir();
const JOBS_ROOT = path.join(AGENT_DIR, "subagent-sessions");
const FEASIBILITY_LEASE_PATH = path.join(
  AGENT_DIR,
  "multi-agent",
  "leases",
  "feasibility.lock",
);
const SUPERVISOR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "supervisor.mjs",
);
const ACTIVE_STATES = new Set<JobState>(["queued", "running", "aborting"]);
const CHILD_TERMINATION_GRACE_MS = 5000;
const SUPERVISOR_TERMINATION_GRACE_MS = 6500;
const SESSION_OUTPUT_READ_CAP = 256 * 1024;
const SESSION_JSON_LINE_CAP = 4 * 1024 * 1024;
const ACTIVITY_JSON_LINE_CAP = 64 * 1024;

function emptyUsage(): UsageStats {
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

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
}

function jobPath(jobDir: string): string {
  return path.join(jobDir, "job.json");
}

function livePath(jobDir: string): string {
  return path.join(jobDir, "live.json");
}

function processPath(jobDir: string): string {
  return path.join(jobDir, "process.json");
}

function activityPath(jobDir: string): string {
  return path.join(jobDir, "activity.jsonl");
}

function launchPath(jobDir: string): string {
  return path.join(jobDir, "launch.json");
}

function readyPath(jobDir: string): string {
  return path.join(jobDir, "launch.ready");
}

function procStartToken(pid: number): string | undefined {
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

async function waitForProcStartToken(
  pid: number,
  timeoutMs = 500,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let token = procStartToken(pid);
  while (!token && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    token = procStartToken(pid);
  }
  return token;
}

function procCommandLine(pid: number): string | undefined {
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ")
      .trim();
  } catch {
    return undefined;
  }
}

function probeProcess(pid: number): "alive" | "dead" | "unverified" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unverified";
  }
}

function inspectProcessIdentity(
  pid: number | undefined,
  expectedStartToken: string | undefined,
  commandNeedles: string[],
): ProcessIdentityState {
  if (!pid) return "dead";
  const probe = probeProcess(pid);
  if (probe === "dead") return "dead";
  if (probe === "unverified") return "unverified";
  if (!expectedStartToken) return "unverified";

  const currentToken = procStartToken(pid);
  if (!currentToken) return "unverified";
  if (currentToken !== expectedStartToken) return "foreign";

  const commandLine = procCommandLine(pid);
  if (!commandLine) return "unverified";
  if (commandNeedles.some((needle) => !commandLine.includes(needle))) {
    return "foreign";
  }
  return "owned";
}

function supervisorIdentity(
  record: ProcessRecord | undefined,
  jobDir: string,
): ProcessIdentityState {
  if (!record) return "dead";
  return inspectProcessIdentity(
    record.supervisorPid,
    record.supervisorStartToken,
    [SUPERVISOR_PATH, jobDir],
  );
}

function childIdentity(
  record: ProcessRecord | undefined,
): ProcessIdentityState {
  if (!record) return "dead";
  return inspectProcessIdentity(record.childPid, record.childStartToken, [
    "--session-id",
    record.jobId,
  ]);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the direct process on platforms without process groups.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // The process may already have exited.
  }
}

async function terminateOwnedChild(
  record: ProcessRecord,
): Promise<ProcessIdentityState> {
  let identity = childIdentity(record);
  if (identity !== "owned" || !record.childPid) return identity;

  signalProcessGroup(record.childPid, "SIGTERM");
  const deadline = Date.now() + CHILD_TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    identity = childIdentity(record);
    if (identity !== "owned") return identity;
  }

  identity = childIdentity(record);
  if (identity === "owned") {
    signalProcessGroup(record.childPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    identity = childIdentity(record);
  }
  return identity;
}

async function mutateJob(
  jobDir: string,
  update: (job: SubagentJobRecord) => SubagentJobRecord,
): Promise<SubagentJobRecord> {
  const current = await readJson<SubagentJobRecord>(jobPath(jobDir));
  const next = update(current);
  await atomicWriteJson(jobPath(jobDir), next);
  return next;
}

async function resolveJobDir(reference: string): Promise<string> {
  await fs.promises.mkdir(JOBS_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fs.promises.readdir(JOBS_ROOT, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (ids.includes(reference)) return path.join(JOBS_ROOT, reference);
  const matches = ids.filter((id) => id.startsWith(reference));
  if (matches.length === 0)
    throw new Error(`Unknown subagent job: ${reference}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous subagent job prefix: ${reference}`);
  }
  return path.join(JOBS_ROOT, matches[0]);
}

async function readProcess(jobDir: string): Promise<ProcessRecord | undefined> {
  try {
    return await readJson<ProcessRecord>(processPath(jobDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function findSessionPath(
  sessionDir: string,
): Promise<string | undefined> {
  try {
    const entries = await fs.promises.readdir(sessionDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const candidate = path.join(sessionDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return candidate;
      if (entry.isDirectory()) {
        const nested = await findSessionPath(candidate);
        if (nested) return nested;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function* readBoundedLines(
  filePath: string,
  maxLineBytes: number,
): AsyncGenerator<string> {
  const input = fs.createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  let buffered = "";
  let discarding = false;
  for await (let chunk of input) {
    if (discarding) {
      const newline = chunk.indexOf("\n");
      if (newline < 0) continue;
      chunk = chunk.slice(newline + 1);
      discarding = false;
    }
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") <= maxLineBytes) yield line;
    }
    if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) {
      buffered = "";
      discarding = true;
    }
  }
  if (!discarding && buffered) yield buffered;
}

function messageText(content: unknown): string {
  if (!Array.isArray(content))
    return typeof content === "string" ? content : "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
      ),
    )
    .map((part) => part.text)
    .join("");
}

async function readSessionFinalOutput(
  sessionPath: string | undefined,
): Promise<string> {
  if (!sessionPath) return "";
  let finalOutput = "";
  try {
    for await (const line of readBoundedLines(
      sessionPath,
      SESSION_JSON_LINE_CAP,
    )) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const text = messageText(entry.message.content);
          if (text) {
            finalOutput = truncateUtf8(text, SESSION_OUTPUT_READ_CAP, {
              tailBytes: 64 * 1024,
            });
          }
        }
      } catch {
        // Ignore a trailing line while another process is appending it.
      }
    }
    return finalOutput;
  } catch {
    return "";
  }
}

async function markOrphaned(
  jobDir: string,
  reason: string,
): Promise<SubagentJobRecord> {
  const now = new Date().toISOString();
  const job = await mutateJob(jobDir, (current) => ({
    ...current,
    state: "orphaned",
    updatedAt: now,
    endedAt: now,
    errorMessage: current.errorMessage || reason,
  }));
  let live: JobLiveSnapshot;
  try {
    live = await readJson<JobLiveSnapshot>(livePath(jobDir));
  } catch {
    live = {
      jobId: job.id,
      state: "orphaned",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: 0,
      activity: "orphaned",
      usage: emptyUsage(),
    };
  }
  await atomicWriteJson(livePath(jobDir), {
    ...live,
    state: "orphaned",
    updatedAt: now,
    lastEventAt: now,
    activity: "orphaned",
    errorMessage: live.errorMessage || reason,
  });
  return job;
}

async function markStartFailed(
  jobDir: string,
  message: string,
): Promise<{ job: SubagentJobRecord; live: JobLiveSnapshot }> {
  const now = new Date().toISOString();
  const job = await mutateJob(jobDir, (current) => ({
    ...current,
    state: "failed",
    updatedAt: now,
    endedAt: now,
    errorMessage: message,
  }));
  let live: JobLiveSnapshot;
  try {
    live = await readJson<JobLiveSnapshot>(livePath(jobDir));
  } catch {
    const job = await readJson<SubagentJobRecord>(jobPath(jobDir));
    live = {
      jobId: job.id,
      state: "failed",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: 0,
      activity: "failed",
      usage: emptyUsage(),
    };
  }
  live = {
    ...live,
    state: "failed",
    updatedAt: now,
    lastEventAt: now,
    activity: "failed",
    errorMessage: message,
  };
  await atomicWriteJson(livePath(jobDir), live);
  return { job, live };
}

async function releasePersistedJobLeases(
  job: SubagentJobRecord,
  strict = false,
): Promise<void> {
  for (const lease of job.leases ?? []) {
    try {
      await releaseLease(lease);
    } catch (error) {
      if (strict) throw error;
    }
  }
}

async function terminateStartingSupervisor(
  pid: number | undefined,
  startToken: string | undefined,
  jobDir: string,
): Promise<void> {
  if (!pid) return;
  let identity = inspectProcessIdentity(pid, startToken, [
    SUPERVISOR_PATH,
    jobDir,
  ]);
  if (identity !== "owned") return;
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + SUPERVISOR_TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    identity = inspectProcessIdentity(pid, startToken, [
      SUPERVISOR_PATH,
      jobDir,
    ]);
    if (identity !== "owned") return;
  }
  if (
    inspectProcessIdentity(pid, startToken, [SUPERVISOR_PATH, jobDir]) ===
    "owned"
  ) {
    signalProcessGroup(pid, "SIGKILL");
  }
}

function ownedJobLeases(options: {
  workspace: PreparedWorkspace;
  feasibilityLease?: LeaseHandle;
}): LeaseHandle[] {
  return [options.feasibilityLease, options.workspace.lease].filter(
    (lease): lease is LeaseHandle => Boolean(lease),
  );
}

async function releaseOwnedLeases(leases: LeaseHandle[]): Promise<void> {
  let firstError: unknown;
  for (const lease of [...leases].reverse()) {
    try {
      await releaseLease(leaseReference(lease));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function transferOwnedLeases(
  leases: LeaseHandle[],
  ownerPid: number,
  ownerStartToken: string,
): Promise<void> {
  for (const lease of leases) {
    await transferLease(lease, {
      ownerPid,
      ownerStartToken,
      phase: "supervisor",
    });
  }
}

async function canRecoverFeasibilityLease(record: {
  jobId?: string;
}): Promise<boolean> {
  if (!record.jobId) return true;
  try {
    const snapshot = await getJobSnapshot(record.jobId);
    return (
      TERMINAL_JOB_STATES.has(snapshot.job.state) &&
      (snapshot.supervisorIdentity === "dead" ||
        snapshot.supervisorIdentity === "foreign") &&
      (snapshot.childIdentity === "dead" ||
        snapshot.childIdentity === "foreign")
    );
  } catch (error) {
    return (
      error instanceof Error &&
      error.message.startsWith("Unknown subagent job:")
    );
  }
}

export async function acquireFeasibilityLease(
  jobId: string,
  signal?: AbortSignal,
): Promise<LeaseHandle> {
  return (await acquireLease(FEASIBILITY_LEASE_PATH, {
    name: "feasibility",
    jobId,
    signal,
    waitMs: 1000,
    canRecover: canRecoverFeasibilityLease,
  })) as LeaseHandle;
}

export async function releaseUnstartedLease(
  lease: LeaseHandle | undefined,
): Promise<void> {
  if (lease) await releaseLease(leaseReference(lease));
}

export function createJobId(): string {
  return randomUUID();
}

export async function startJob(options: {
  id: string;
  config: AgentConfig;
  task: DelegatedTask;
  model: string;
  workspace: PreparedWorkspace;
  feasibilityLease?: LeaseHandle;
  guardPath: string;
}): Promise<JobSnapshot> {
  const id = options.id;
  const leases = ownedJobLeases(options);
  const jobDir = path.join(JOBS_ROOT, id);
  const sessionDir = path.join(jobDir, "sessions");
  const now = new Date().toISOString();
  try {
    await fs.promises.mkdir(jobDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    await releaseOwnedLeases(leases);
    throw error;
  }

  const job: SubagentJobRecord = {
    version: 1,
    id,
    agent: options.task.agent,
    task: options.task.task,
    mode: options.task.workspace,
    model: options.model,
    state: "queued",
    cwd: options.workspace.cwd,
    sourceRoot: options.workspace.sourceRoot,
    jobDir,
    sessionDir,
    createdAt: now,
    updatedAt: now,
    workspace: options.workspace.record,
    leases: leases.map((lease) => leaseReference(lease)) as LeaseReference[],
  };
  const live: JobLiveSnapshot = {
    jobId: id,
    state: "queued",
    updatedAt: now,
    lastEventAt: now,
    activitySeq: 0,
    activity: "queued",
    usage: emptyUsage(),
  };

  try {
    await atomicWriteJson(jobPath(jobDir), job);
    await atomicWriteJson(livePath(jobDir), live);
  } catch (error) {
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    await releaseOwnedLeases(leases);
    throw error;
  }

  let logFd: number | undefined;
  let supervisorPid: number | undefined;
  let supervisorStartToken: string | undefined;
  try {
    const launch = await prepareAgentLaunch({
      jobId: id,
      jobDir,
      sessionDir,
      config: options.config,
      task: options.task,
      model: options.model,
      workspace: options.workspace,
      guardPath: options.guardPath,
    });
    await atomicWriteJson(launchPath(jobDir), launch);

    logFd = fs.openSync(path.join(jobDir, "supervisor.log"), "a", 0o600);
    const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, jobDir], {
      detached: true,
      shell: false,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    });
    supervisorPid = supervisor.pid;
    supervisorStartToken = supervisorPid
      ? await waitForProcStartToken(supervisorPid)
      : undefined;
    const processRecord: ProcessRecord = {
      jobId: id,
      supervisorPid: supervisorPid!,
      supervisorStartToken,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(processPath(jobDir), processRecord);
    if (!supervisorStartToken) {
      throw new Error(
        "Supervisor identity could not be verified for lease handoff",
      );
    }
    await transferOwnedLeases(
      leases,
      processRecord.supervisorPid,
      supervisorStartToken,
    );
    await fs.promises.writeFile(readyPath(jobDir), "ready\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    supervisor.unref();

    const deadline = Date.now() + 1500;
    let snapshot = await getJobSnapshot(id);
    while (snapshot.job.state === "queued" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      snapshot = await getJobSnapshot(id);
    }
    return snapshot;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `Failed to start supervisor: ${cause}`;
    await terminateStartingSupervisor(
      supervisorPid,
      supervisorStartToken,
      jobDir,
    );
    let processRecord: ProcessRecord | undefined;
    let processRecoveryVerified = supervisorPid === undefined;
    try {
      processRecord = await readProcess(jobDir);
      processRecoveryVerified = true;
      if (processRecord && childIdentity(processRecord) === "owned") {
        await terminateOwnedChild(processRecord);
      }
    } catch {
      // Preserve leases when process recovery is unavailable.
    }
    const fallbackProcessRecord =
      processRecord ??
      (supervisorPid
        ? {
            jobId: id,
            supervisorPid,
            supervisorStartToken,
            updatedAt: new Date().toISOString(),
          }
        : undefined);
    const supervisorState = supervisorIdentity(fallbackProcessRecord, jobDir);
    const childState = childIdentity(processRecord);
    const failed = await markStartFailed(jobDir, message);
    if (
      processRecoveryVerified &&
      (supervisorState === "dead" || supervisorState === "foreign") &&
      (childState === "dead" || childState === "foreign")
    ) {
      await releaseOwnedLeases(leases);
    }
    try {
      return await getJobSnapshot(id);
    } catch {
      return {
        job: failed.job,
        live: failed.live,
        elapsedMs: 0,
        processAlive: supervisorState === "owned",
        childAlive: childState === "owned",
        supervisorIdentity: supervisorState,
        childIdentity: childState,
      };
    }
  } finally {
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // A log descriptor close failure must not hide the retained job ID.
      }
    }
  }
}

export async function getJobSnapshot(reference: string): Promise<JobSnapshot> {
  const jobDir = await resolveJobDir(reference);
  let job = await readJson<SubagentJobRecord>(jobPath(jobDir));
  let processRecord = await readProcess(jobDir);
  let supervisorState = supervisorIdentity(processRecord, jobDir);
  let childState = childIdentity(processRecord);

  if (
    ACTIVE_STATES.has(job.state) &&
    (supervisorState === "dead" || supervisorState === "foreign")
  ) {
    // Give a normally exiting supervisor one final chance to persist terminal state.
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await readJson<SubagentJobRecord>(jobPath(jobDir));
    processRecord = await readProcess(jobDir);
    supervisorState = supervisorIdentity(processRecord, jobDir);
    childState = childIdentity(processRecord);

    if (
      ACTIVE_STATES.has(job.state) &&
      (supervisorState === "dead" || supervisorState === "foreign")
    ) {
      let reason = "The detached supervisor is no longer running.";
      if (childState === "owned" && processRecord) {
        childState = await terminateOwnedChild(processRecord);
        reason =
          childState === "dead" || childState === "foreign"
            ? "The detached supervisor exited; its remaining child process was terminated."
            : "The detached supervisor exited, but child termination could not be verified.";
      } else if (childState === "unverified") {
        reason =
          "The detached supervisor exited; the recorded child identity could not be verified, so no signal was sent.";
      }
      job = await markOrphaned(jobDir, reason);
    }
  } else if (
    job.state === "orphaned" &&
    (supervisorState === "dead" || supervisorState === "foreign") &&
    childState === "owned" &&
    processRecord
  ) {
    // Recover child processes left behind by older or interrupted supervisors.
    childState = await terminateOwnedChild(processRecord);
  }

  if (
    TERMINAL_JOB_STATES.has(job.state) &&
    (supervisorState === "dead" || supervisorState === "foreign") &&
    (childState === "dead" || childState === "foreign")
  ) {
    await releasePersistedJobLeases(job);
  }

  let live: JobLiveSnapshot;
  try {
    live = await readJson<JobLiveSnapshot>(livePath(jobDir));
  } catch {
    live = {
      jobId: job.id,
      state: job.state,
      updatedAt: job.updatedAt,
      lastEventAt: job.updatedAt,
      activitySeq: 0,
      activity: job.state,
      usage: emptyUsage(),
    };
  }
  live.state = job.state;

  const started = Date.parse(job.startedAt ?? job.createdAt);
  const ended = job.endedAt ? Date.parse(job.endedAt) : Date.now();
  const toolElapsedMs = live.currentTool
    ? Math.max(0, Date.now() - Date.parse(live.currentTool.startedAt))
    : undefined;
  return {
    job,
    live,
    elapsedMs: Math.max(0, ended - started),
    toolElapsedMs,
    processAlive: supervisorState === "owned",
    childAlive: childState === "owned",
    supervisorIdentity: supervisorState,
    childIdentity: childState,
  };
}

export async function listJobSnapshots(limit = 50): Promise<JobSnapshot[]> {
  await fs.promises.mkdir(JOBS_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fs.promises.readdir(JOBS_ROOT, { withFileTypes: true });
  const records: SubagentJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(
        await readJson<SubagentJobRecord>(
          jobPath(path.join(JOBS_ROOT, entry.name)),
        ),
      );
    } catch {
      // Ignore malformed job directories in list output.
    }
  }
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const snapshots: JobSnapshot[] = [];
  for (const record of records.slice(0, Math.max(1, limit))) {
    snapshots.push(await getJobSnapshot(record.id));
  }
  return snapshots;
}

async function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    throw new Error("Wait cancelled; subagent continues running");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Wait cancelled; subagent continues running"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForJob(
  reference: string,
  waitSeconds = 300,
  signal?: AbortSignal,
  onUpdate?: (snapshot: JobSnapshot) => void,
): Promise<JobSnapshot> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let snapshot = await getJobSnapshot(reference);
  onUpdate?.(snapshot);
  while (
    !TERMINAL_JOB_STATES.has(snapshot.job.state) &&
    Date.now() < deadline
  ) {
    await sleepWithSignal(
      Math.min(1000, Math.max(1, deadline - Date.now())),
      signal,
    );
    snapshot = await getJobSnapshot(reference);
    onUpdate?.(snapshot);
  }
  return snapshot;
}

async function readActivities(
  jobDir: string,
  cursor: number,
  limit: number,
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  try {
    for await (const line of readBoundedLines(
      activityPath(jobDir),
      ACTIVITY_JSON_LINE_CAP,
    )) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ActivityEvent;
        if (event.seq > cursor) events.push(event);
        if (events.length >= Math.max(1, limit)) break;
      } catch {
        // Ignore a trailing line while the supervisor is appending it.
      }
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function getJobResult(
  reference: string,
  cursor = 0,
  limit = 100,
): Promise<JobResultSnapshot> {
  const snapshot = await getJobSnapshot(reference);
  const activities = await readActivities(snapshot.job.jobDir, cursor, limit);
  const nextCursor = activities.length
    ? activities[activities.length - 1].seq
    : cursor;
  const sessionPath =
    snapshot.job.sessionPath ??
    (await findSessionPath(snapshot.job.sessionDir));
  const finalOutput = TERMINAL_JOB_STATES.has(snapshot.job.state)
    ? (await readSessionFinalOutput(sessionPath)) ||
      snapshot.live.latestCompletedOutput
    : undefined;
  return {
    ...snapshot,
    activities,
    nextCursor,
    finalOutput,
  };
}

export async function abortJob(reference: string): Promise<JobSnapshot> {
  const snapshot = await getJobSnapshot(reference);
  const processRecord = await readProcess(snapshot.job.jobDir);

  if (snapshot.supervisorIdentity === "owned" && processRecord) {
    try {
      process.kill(processRecord.supervisorPid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return getJobSnapshot(snapshot.job.id);
  }

  if (
    snapshot.childIdentity === "owned" &&
    processRecord &&
    (snapshot.supervisorIdentity === "dead" ||
      snapshot.supervisorIdentity === "foreign")
  ) {
    await terminateOwnedChild(processRecord);
    return getJobSnapshot(snapshot.job.id);
  }

  if (TERMINAL_JOB_STATES.has(snapshot.job.state)) return snapshot;
  throw new Error(
    `Cannot abort job ${snapshot.job.id} because the supervisor identity is ${snapshot.supervisorIdentity} and child identity is ${snapshot.childIdentity}`,
  );
}

export async function cleanupJob(
  reference: string,
): Promise<SubagentJobRecord> {
  const snapshot = await getJobSnapshot(reference);
  if (!TERMINAL_JOB_STATES.has(snapshot.job.state)) {
    throw new Error(`Cannot clean active job ${snapshot.job.id}`);
  }
  if (
    snapshot.supervisorIdentity === "owned" ||
    snapshot.supervisorIdentity === "unverified"
  ) {
    throw new Error(
      `Cannot clean job ${snapshot.job.id} while its supervisor identity is ${snapshot.supervisorIdentity}`,
    );
  }
  if (
    snapshot.childIdentity === "owned" ||
    snapshot.childIdentity === "unverified"
  ) {
    throw new Error(
      `Cannot clean job ${snapshot.job.id} while its child identity is ${snapshot.childIdentity}`,
    );
  }
  await releasePersistedJobLeases(snapshot.job, true);
  await fs.promises.rm(snapshot.job.jobDir, { recursive: true, force: true });
  return snapshot.job;
}

export async function findJobUsingWorkspace(
  workspaceId: string,
  activeOnly = false,
): Promise<JobSnapshot | undefined> {
  const jobs = await listJobSnapshots(Number.MAX_SAFE_INTEGER);
  return jobs.find((snapshot) => {
    if (snapshot.job.workspace?.id !== workspaceId) return false;
    if (!activeOnly) return true;
    return (
      !TERMINAL_JOB_STATES.has(snapshot.job.state) ||
      snapshot.supervisorIdentity === "owned" ||
      snapshot.supervisorIdentity === "unverified" ||
      snapshot.childIdentity === "owned" ||
      snapshot.childIdentity === "unverified"
    );
  });
}

export async function findActiveJobUsingWorkspace(
  workspaceId: string,
): Promise<JobSnapshot | undefined> {
  return findJobUsingWorkspace(workspaceId, true);
}

export async function hasActiveFeasibilityJob(): Promise<boolean> {
  const jobs = await listJobSnapshots(Number.MAX_SAFE_INTEGER);
  return jobs.some(
    (snapshot) =>
      snapshot.job.agent === "feasibility" &&
      !TERMINAL_JOB_STATES.has(snapshot.job.state),
  );
}

export async function readLaunchConfig(jobDir: string): Promise<LaunchConfig> {
  return readJson<LaunchConfig>(launchPath(jobDir));
}
