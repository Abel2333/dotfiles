import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireLease, leaseReference, releaseLease } from "./lease.mjs";
import type {
  LeaseHandle,
  PreparedWorkspace,
  WorkspaceMode,
  WorkspaceRecord,
} from "./types";

const STATE_DIR = path.join(getAgentDir(), "multi-agent");
const REGISTRY_PATH = path.join(STATE_DIR, "workspaces.json");
const LEASE_DIR = path.join(STATE_DIR, "leases");
const REGISTRY_LEASE_PATH = path.join(LEASE_DIR, "workspace-registry.lock");
const TEMP_ROOT = path.join(os.tmpdir(), "pi-multi-agent");

interface GitState {
  repoRoot: string;
  relativeCwd: string;
  dirty: boolean;
  status: string;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      proc.kill("SIGTERM");
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(new Error("Workspace operation aborted"));
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
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
    return { repoRoot, relativeCwd, dirty: status.length > 0, status };
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
      await run(
        "git",
        [
          "-C",
          git!.repoRoot,
          "worktree",
          "add",
          "--detach",
          workspacePath,
          "HEAD",
        ],
        { signal },
      );
    }
    resourceCreated = true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    let resourceCleanupVerified = false;
    try {
      if (mode === "worktree" && git) {
        if (fs.existsSync(workspacePath)) {
          await run("git", [
            "-C",
            git.repoRoot,
            "worktree",
            "remove",
            "--force",
            workspacePath,
          ]);
        }
        await run("git", ["-C", git.repoRoot, "worktree", "prune"]);
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
  } = {},
): Promise<WorkspaceRecord> {
  const lease = await acquireWorkspaceLease(id, `cleanup:${process.pid}`, {
    waitMs: 5000,
    canRecover: options.canRecoverLease,
  });
  try {
    const records = await readRegistry();
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error(`Unknown workspace: ${id}`);

    if (record.mode === "worktree" && record.repoRoot) {
      if (fs.existsSync(record.path)) {
        await run("git", [
          "-C",
          record.repoRoot,
          "worktree",
          "remove",
          "--force",
          record.path,
        ]);
      }
      await run("git", ["-C", record.repoRoot, "worktree", "prune"]);
    } else {
      await fs.promises.rm(record.path, { recursive: true, force: true });
    }

    await removeRecord(id);
    return record;
  } finally {
    await releaseLease(leaseReference(lease));
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
        await run("git", ["-C", record.repoRoot, "worktree", "prune"]);
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
