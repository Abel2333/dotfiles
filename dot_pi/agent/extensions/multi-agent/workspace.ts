import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLease,
  leaseReference,
  procStartToken,
  releaseLease,
  transferLease,
} from "./lease.mjs";
import {
  MULTI_AGENT_LEASE_DIR,
  MULTI_AGENT_STATE_DIR,
  canonicalResourcePath,
  gitMetadataLeasePath,
  worktreeWriterLeasePath,
} from "./lease-scope.mjs";
import type {
  LeaseHandle,
  PreparedWorkspace,
  WorkspaceMode,
  WorkspaceRecord,
} from "./types";

const STATE_DIR = MULTI_AGENT_STATE_DIR;
const REGISTRY_PATH = path.join(STATE_DIR, "workspaces.json");
const LEASE_DIR = MULTI_AGENT_LEASE_DIR;
const REGISTRY_LEASE_PATH = path.join(LEASE_DIR, "workspace-registry.lock");
const TEMP_ROOT = path.join(os.tmpdir(), "pi-multi-agent");
const GIT_GATE_SCRIPT = [
  'IFS= read -r gate || exit 125',
  '[ "$gate" = run ] || exit 125',
  'exec "$@"',
].join("\n");

interface GitState {
  repoRoot: string;
  commonDir: string;
  relativeCwd: string;
  dirty: boolean;
  status: string;
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

function terminateProcess(proc: ReturnType<typeof spawn>): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    return;
  } catch {
    // Fall back when the process has no dedicated process group.
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    leases?: LeaseHandle[];
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const gated = Boolean(options.leases?.length);
    const proc = spawn(
      gated ? "/bin/sh" : command,
      gated
        ? ["-c", GIT_GATE_SCRIPT, "pi-git-gate", command, ...args]
        : args,
      {
        cwd: options.cwd,
        detached: gated,
        shell: false,
        stdio: [gated ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let setupError: unknown;

    const abort = () => {
      aborted = true;
      if (gated) terminateProcess(proc);
      else proc.kill("SIGTERM");
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.stdin?.on("error", (error) => {
      if (aborted || setupError) return;
      setupError = error;
      terminateProcess(proc);
    });
    proc.on("spawn", () => {
      if (!gated) return;
      void (async () => {
        if (aborted) throw new Error("Workspace operation aborted");
        const ownerStartToken = await waitForProcStartToken(proc.pid!);
        if (!ownerStartToken) {
          throw new Error("Git operation owner identity is unverified");
        }
        for (const lease of options.leases ?? []) {
          await transferLease(lease, {
            ownerPid: proc.pid!,
            ownerStartToken,
            phase: "git-operation",
          });
        }
        if (aborted) throw new Error("Workspace operation aborted");
        proc.stdin!.end("run\n");
      })().catch((error) => {
        setupError = error;
        terminateProcess(proc);
      });
    });
    proc.on("error", (error) => {
      setupError ??= error;
    });
    proc.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (setupError) {
        reject(setupError);
      } else if (aborted) {
        reject(new Error("Workspace operation aborted"));
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code ?? 1}): ${stderr.trim()}`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function readRegistry(): Promise<WorkspaceRecord[]> {
  try {
    const raw = await fs.promises.readFile(REGISTRY_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as WorkspaceRecord[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function mutateRegistry(
  update: (records: WorkspaceRecord[]) => WorkspaceRecord[],
): Promise<void> {
  await fs.promises.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const lease = (await acquireLease(REGISTRY_LEASE_PATH, {
    name: "workspace-registry",
    waitMs: 5000,
  })) as LeaseHandle;
  try {
    const records = await readRegistry();
    const tmp = `${REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(
      tmp,
      `${JSON.stringify(update(records), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.promises.rename(tmp, REGISTRY_PATH);
  } finally {
    await releaseLease(leaseReference(lease));
  }
}

async function addRecord(record: WorkspaceRecord): Promise<void> {
  await mutateRegistry((records) => [...records, record]);
}

async function removeRecord(id: string): Promise<void> {
  await mutateRegistry((records) =>
    records.filter((record) => record.id !== id),
  );
}

export async function inspectGitState(cwd: string): Promise<GitState | null> {
  try {
    const rootResult = await run("git", [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    const repoRoot = await fs.promises.realpath(rootResult.stdout.trim());
    const commonDirResult = await run("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--git-common-dir",
    ]);
    const commonDir = await fs.promises.realpath(
      path.resolve(repoRoot, commonDirResult.stdout.trim()),
    );
    const resolvedCwd = await fs.promises.realpath(cwd);
    const relativeCwd = path.relative(repoRoot, resolvedCwd);
    const statusResult = await run("git", [
      "-C",
      repoRoot,
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    const status = statusResult.stdout.trim();
    return {
      repoRoot,
      commonDir,
      relativeCwd,
      dirty: status.length > 0,
      status,
    };
  } catch {
    return null;
  }
}

export async function resolveSourceRoot(cwd: string): Promise<string> {
  const git = await inspectGitState(cwd);
  if (git) return git.repoRoot;
  return fs.promises.realpath(cwd);
}

function workspaceLeasePath(id: string): string {
  return path.join(LEASE_DIR, `workspace-${id}.lock`);
}

async function acquireWorkspaceLease(
  id: string,
  jobId: string | undefined,
  options: {
    signal?: AbortSignal;
    waitMs?: number;
    canRecover?: (record: unknown) => Promise<boolean>;
  } = {},
): Promise<LeaseHandle> {
  return (await acquireLease(workspaceLeasePath(id), {
    name: `workspace:${id}`,
    jobId,
    signal: options.signal,
    waitMs: options.waitMs ?? 5000,
    canRecover: options.canRecover,
  })) as LeaseHandle;
}

async function runGitMetadataCommand(
  commonDir: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    waitMs?: number;
    additionalLeases?: LeaseHandle[];
  } = {},
): Promise<void> {
  const metadataLease = (await acquireLease(gitMetadataLeasePath(commonDir), {
    name: `git-metadata:${commonDir}`,
    signal: options.signal,
    waitMs: options.waitMs ?? 5000,
  })) as LeaseHandle;
  try {
    await run("git", args, {
      signal: options.signal,
      leases: [...(options.additionalLeases ?? []), metadataLease],
    });
  } finally {
    await releaseLease(leaseReference(metadataLease));
  }
}

async function resolveRecordCommonDir(
  record: WorkspaceRecord,
): Promise<string> {
  if (record.gitCommonDir) {
    return canonicalResourcePath(record.gitCommonDir);
  }
  if (!record.repoRoot) throw new Error("Worktree record has no repository");
  const git = await inspectGitState(record.repoRoot);
  if (!git) throw new Error(`Repository is unavailable: ${record.repoRoot}`);
  return git.commonDir;
}

async function acquireCleanupWriterLease(
  workspacePath: string,
  waitMs: number,
): Promise<LeaseHandle> {
  const canonicalRoot = await canonicalResourcePath(workspacePath);
  return (await acquireLease(worktreeWriterLeasePath(canonicalRoot), {
    name: `worktree-writer:${canonicalRoot}`,
    jobId: `cleanup:${process.pid}`,
    waitMs,
  })) as LeaseHandle;
}

export async function releasePreparedWorkspaceLease(
  workspace: PreparedWorkspace | undefined,
): Promise<void> {
  if (!workspace?.lease) return;
  await releaseLease(leaseReference(workspace.lease));
  workspace.lease = undefined;
}

export async function prepareWorkspace(
  mode: WorkspaceMode,
  cwd: string,
  task: string,
  signal?: AbortSignal,
  jobId?: string,
): Promise<PreparedWorkspace> {
  const sourceRoot = await resolveSourceRoot(cwd);
  if (mode === "research") {
    return { mode, cwd, sourceRoot };
  }

  if (mode === "project") {
    const git = await inspectGitState(cwd);
    if (!git) throw new Error("Project mode requires a Git repository");
    return {
      mode,
      cwd: await fs.promises.realpath(cwd),
      sourceRoot: git.repoRoot,
      writableRoot: git.repoRoot,
    };
  }

  const git = mode === "worktree" ? await inspectGitState(cwd) : null;
  if (mode === "worktree" && !git) {
    throw new Error("Worktree mode requires a Git repository");
  }

  await fs.promises.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  const id = randomUUID().slice(0, 12);
  const workspacePath = path.join(TEMP_ROOT, `${mode}-${id}`);
  const lease = await acquireWorkspaceLease(id, jobId, {
    signal,
    waitMs: 30_000,
  });
  const record: WorkspaceRecord = {
    id,
    jobId,
    mode,
    path: workspacePath,
    sourceRoot: git?.repoRoot ?? sourceRoot,
    repoRoot: git?.repoRoot,
    gitCommonDir: git?.commonDir,
    createdAt: new Date().toISOString(),
    task,
  };
  let recordAdded = false;
  let resourceCreated = false;

  try {
    await addRecord(record);
    recordAdded = true;
    if (mode === "scratch") {
      await fs.promises.mkdir(workspacePath, { mode: 0o700 });
    } else {
      await runGitMetadataCommand(
        git!.commonDir,
        [
          "-C",
          git!.repoRoot,
          "worktree",
          "add",
          "--detach",
          workspacePath,
          "HEAD",
        ],
        { signal, waitMs: 30_000 },
      );
    }
    resourceCreated = true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    let resourceCleanupVerified = false;
    try {
      if (mode === "worktree" && git) {
        if (fs.existsSync(workspacePath)) {
          await runGitMetadataCommand(
            git.commonDir,
            [
              "-C",
              git.repoRoot,
              "worktree",
              "remove",
              "--force",
              workspacePath,
            ],
            { waitMs: 30_000 },
          );
        }
        await runGitMetadataCommand(
          git.commonDir,
          ["-C", git.repoRoot, "worktree", "prune"],
          { waitMs: 30_000 },
        );
      } else if (resourceCreated || fs.existsSync(workspacePath)) {
        await fs.promises.rm(workspacePath, { recursive: true, force: true });
      }
      resourceCleanupVerified = true;
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (!recordAdded) {
      try {
        recordAdded = (await readRegistry()).some((item) => item.id === id);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (recordAdded && resourceCleanupVerified) {
      try {
        await removeRecord(id);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length === 0) {
      await releaseLease(leaseReference(lease));
      throw error;
    }
    throw new AggregateError(
      [error, ...rollbackErrors],
      "Workspace preparation failed and rollback could not be verified; the lease was retained",
    );
  }

  return {
    mode,
    cwd:
      mode === "worktree"
        ? path.join(workspacePath, git!.relativeCwd)
        : workspacePath,
    sourceRoot: record.sourceRoot,
    writableRoot: workspacePath,
    record,
    lease,
  };
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const records = await readRegistry();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cleanupWorkspace(
  id: string,
  options: {
    canRecoverLease?: (record: unknown) => Promise<boolean>;
    writerWaitMs?: number;
    metadataWaitMs?: number;
  } = {},
): Promise<WorkspaceRecord> {
  const lease = await acquireWorkspaceLease(id, `cleanup:${process.pid}`, {
    waitMs: 5000,
    canRecover: options.canRecoverLease,
  });
  let writerLease: LeaseHandle | undefined;
  try {
    const records = await readRegistry();
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error(`Unknown workspace: ${id}`);

    if (record.mode === "worktree" && record.repoRoot) {
      if (fs.existsSync(record.path)) {
        writerLease = await acquireCleanupWriterLease(
          record.path,
          options.writerWaitMs ?? 5000,
        );
      }
      const commonDir = await resolveRecordCommonDir(record);
      const additionalLeases = writerLease ? [writerLease] : [];
      if (fs.existsSync(record.path)) {
        await runGitMetadataCommand(
          commonDir,
          [
            "-C",
            record.repoRoot,
            "worktree",
            "remove",
            "--force",
            record.path,
          ],
          {
            waitMs: options.metadataWaitMs ?? 5000,
            additionalLeases,
          },
        );
      }
      await runGitMetadataCommand(
        commonDir,
        ["-C", record.repoRoot, "worktree", "prune"],
        {
          waitMs: options.metadataWaitMs ?? 5000,
          additionalLeases,
        },
      );
    } else {
      await fs.promises.rm(record.path, { recursive: true, force: true });
    }

    await removeRecord(id);
    return record;
  } finally {
    try {
      if (writerLease) await releaseLease(leaseReference(writerLease));
    } finally {
      await releaseLease(leaseReference(lease));
    }
  }
}

export async function pruneMissingWorkspaces(
  options: {
    canRecoverLease?: (record: WorkspaceRecord) => Promise<boolean>;
  } = {},
): Promise<number> {
  const records = await readRegistry();
  let removed = 0;
  for (const record of records) {
    if (fs.existsSync(record.path)) continue;
    let lease: LeaseHandle;
    try {
      lease = await acquireWorkspaceLease(record.id, `prune:${process.pid}`, {
        waitMs: 0,
        canRecover: async () =>
          options.canRecoverLease ? options.canRecoverLease(record) : false,
      });
    } catch {
      continue;
    }
    try {
      if (record.mode === "worktree" && record.repoRoot) {
        const commonDir = await resolveRecordCommonDir(record);
        await runGitMetadataCommand(
          commonDir,
          ["-C", record.repoRoot, "worktree", "prune"],
          { waitMs: 0 },
        );
      }
      await removeRecord(record.id);
      removed += 1;
    } catch {
      // Leave the registry record available for a later retry.
    } finally {
      await releaseLease(leaseReference(lease));
    }
  }
  return removed;
}
