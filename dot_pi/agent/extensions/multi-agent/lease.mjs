import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function procStartToken(pid) {
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

function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unverified";
  }
}

export function inspectLeaseOwner(record) {
  if (
    !record ||
    record.version !== 1 ||
    typeof record.token !== "string" ||
    !record.token ||
    !Number.isSafeInteger(record.ownerPid) ||
    record.ownerPid <= 0 ||
    typeof record.ownerStartToken !== "string" ||
    !record.ownerStartToken
  ) {
    return "unverified";
  }
  const probe = probeProcess(record.ownerPid);
  if (probe === "dead") return "dead";
  if (probe === "unverified") return "unverified";
  const current = procStartToken(record.ownerPid);
  if (!current) return "unverified";
  return current === record.ownerStartToken ? "owned" : "foreign";
}

function ownerRecordPath(filePath, token) {
  return `${filePath}.${token}.owner`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function readLease(filePath) {
  const record = await readJson(filePath);
  if (typeof record?.token !== "string" || !record.token) return record;
  try {
    const owner = await readJson(ownerRecordPath(filePath, record.token));
    if (owner.token !== record.token) {
      throw new Error(`Lease owner record token mismatch for ${record.name}`);
    }
    return { ...record, ...owner };
  } catch (error) {
    if (error?.code === "ENOENT") return record;
    throw error;
  }
}

async function publishRecord(filePath, record) {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.candidate`;
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.link(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function atomicReplace(filePath, record) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(
    temporary,
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await fs.promises.rename(temporary, filePath);
}

async function recoverAbandonedGuard(recoveryPath, observed) {
  const identity = inspectLeaseOwner(observed);
  if (identity !== "dead" && identity !== "foreign") return false;
  const abandonedPath = `${recoveryPath}.${observed.token}.abandoned`;
  try {
    await fs.promises.rename(recoveryPath, abandonedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const moved = await readLease(abandonedPath);
  if (moved.token !== observed.token) {
    try {
      await fs.promises.rename(abandonedPath, recoveryPath);
    } catch {
      // Preserve the unexpected guard for manual diagnosis.
    }
    throw new Error("Lease recovery guard changed during recovery");
  }
  await fs.promises.rm(abandonedPath, { force: true });
  return true;
}

async function recoverStaleLease(filePath, observed, canRecover) {
  const recoveryPath = `${filePath}.recovery`;
  const ownerStartToken = procStartToken(process.pid);
  if (!ownerStartToken) {
    throw new Error(
      `Cannot recover lease ${observed.name}: current process identity is unverified`,
    );
  }
  const recovery = {
    version: 1,
    name: `${observed.name}:recovery`,
    token: randomUUID(),
    ownerPid: process.pid,
    ownerStartToken,
    createdAt: new Date().toISOString(),
  };
  try {
    await publishRecord(recoveryPath, recovery);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  try {
    let current;
    try {
      current = await readLease(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw new Error(
        `Cannot verify existing lease ${observed.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (current.token !== observed.token) return false;
    const identity = inspectLeaseOwner(current);
    if (identity !== "dead" && identity !== "foreign") return false;
    if (canRecover && !(await canRecover(current))) return false;

    const stalePath = `${filePath}.${current.token}.stale`;
    try {
      await fs.promises.rename(filePath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    const moved = await readJson(stalePath);
    if (moved.token !== current.token) {
      try {
        await fs.promises.rename(stalePath, filePath);
      } catch {
        // Preserve the unexpected lease for manual diagnosis.
      }
      throw new Error(`Lease ${observed.name} changed during stale recovery`);
    }
    await fs.promises.rm(stalePath, { force: true });
    await fs.promises.rm(ownerRecordPath(filePath, current.token), {
      force: true,
    });
    return true;
  } finally {
    await releaseLease({
      path: recoveryPath,
      token: recovery.token,
      name: recovery.name,
    });
  }
}

export async function acquireLease(filePath, options) {
  const ownerStartToken = procStartToken(process.pid);
  if (!ownerStartToken) {
    throw new Error(
      `Cannot acquire lease ${options.name}: current process identity is unverified`,
    );
  }
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  const record = {
    version: 1,
    name: options.name,
    token: randomUUID(),
    ownerPid: process.pid,
    ownerStartToken,
    jobId: options.jobId,
    phase: options.phase ?? "preparing",
    createdAt: new Date().toISOString(),
  };

  for (;;) {
    if (options.signal?.aborted)
      throw new Error(`Lease acquisition cancelled: ${options.name}`);
    const recoveryPath = `${filePath}.recovery`;
    try {
      const recovery = await readLease(recoveryPath);
      if (await recoverAbandonedGuard(recoveryPath, recovery)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Lease ${options.name} recovery is already in progress; owner identity is ${inspectLeaseOwner(recovery)}`,
        );
      }
      await sleep(50);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    try {
      await publishRecord(filePath, record);
      try {
        await fs.promises.access(`${filePath}.recovery`);
        await releaseLease({
          path: filePath,
          token: record.token,
          name: record.name,
        });
        if (Date.now() >= deadline) {
          throw new Error(
            `Lease ${options.name} recovery started during acquisition`,
          );
        }
        await sleep(50);
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return { path: filePath, ...record };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let existing;
    try {
      existing = await readLease(filePath);
    } catch (error) {
      throw new Error(
        `Cannot verify existing lease ${options.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const identity = inspectLeaseOwner(existing);
    if (identity === "dead" || identity === "foreign") {
      const recovered = await recoverStaleLease(
        filePath,
        existing,
        options.canRecover,
      );
      if (recovered) continue;
    }
    if (Date.now() >= deadline) {
      const owner = existing.jobId ? ` for job ${existing.jobId}` : "";
      throw new Error(
        `Lease ${options.name} is held${owner}; owner identity is ${identity}`,
      );
    }
    await sleep(50);
  }
}

export async function transferLease(handle, owner) {
  const current = await readLease(handle.path);
  if (current.token !== handle.token) {
    throw new Error(
      `Cannot transfer lease ${handle.name}: ownership token changed`,
    );
  }
  if (!owner.ownerStartToken) {
    throw new Error(
      `Cannot transfer lease ${handle.name}: new owner identity is unverified`,
    );
  }
  const nextOwner = {
    version: 1,
    token: current.token,
    ownerPid: owner.ownerPid,
    ownerStartToken: owner.ownerStartToken,
    phase: owner.phase ?? "supervisor",
    updatedAt: new Date().toISOString(),
  };
  await atomicReplace(ownerRecordPath(handle.path, current.token), nextOwner);
  return { path: handle.path, ...current, ...nextOwner };
}

export async function releaseLease(reference) {
  let current;
  try {
    current = await readLease(reference.path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (current.token !== reference.token) {
    throw new Error(
      `Cannot release lease ${reference.name}: ownership token changed`,
    );
  }
  const releasedPath = `${reference.path}.${reference.token}.released`;
  await fs.promises.rename(reference.path, releasedPath);
  const moved = await readJson(releasedPath);
  if (moved.token !== reference.token) {
    try {
      await fs.promises.rename(releasedPath, reference.path);
    } catch {
      // Preserve the unexpected lease for manual diagnosis.
    }
    throw new Error(
      `Cannot release lease ${reference.name}: lease changed during release`,
    );
  }
  await fs.promises.rm(releasedPath, { force: true });
  await fs.promises.rm(ownerRecordPath(reference.path, reference.token), {
    force: true,
  });
  return true;
}

export function leaseReference(handle) {
  return {
    path: handle.path,
    token: handle.token,
    name: handle.name,
    jobId: handle.jobId,
  };
}
