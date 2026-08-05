import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireLease,
  inspectLeaseOwner,
  leaseReference,
  procStartToken,
  releaseLease,
  transferLease,
} from "../lease.mjs";

async function withTempLease(run) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-ma-lease-"),
  );
  try {
    await run(path.join(root, "test.lock"));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test("lease acquisition is exclusive and token checked", async () => {
  await withTempLease(async (leasePath) => {
    const first = await acquireLease(leasePath, { name: "test", waitMs: 0 });
    await assert.rejects(
      acquireLease(leasePath, { name: "test", waitMs: 0 }),
      /owner identity is owned/,
    );
    await assert.rejects(
      releaseLease({ ...leaseReference(first), token: "wrong" }),
      /ownership token changed/,
    );
    await releaseLease(leaseReference(first));
    const second = await acquireLease(leasePath, { name: "test", waitMs: 0 });
    await releaseLease(leaseReference(second));
  });
});

test("independent processes cannot acquire the same lease concurrently", async () => {
  await withTempLease(async (leasePath) => {
    const gate = `${leasePath}.gate`;
    const moduleUrl = new URL("../lease.mjs", import.meta.url).href;
    const source = `import * as fs from "node:fs";import { acquireLease, leaseReference, releaseLease } from ${JSON.stringify(moduleUrl)};const gate=${JSON.stringify(gate)};while(!fs.existsSync(gate)) await new Promise(r=>setTimeout(r,5));try{const lease=await acquireLease(${JSON.stringify(leasePath)},{name:"cross-process",waitMs:0});await new Promise(r=>setTimeout(r,500));await releaseLease(leaseReference(lease));process.exit(0)}catch{process.exit(2)}`;
    const workers = [
      spawn(process.execPath, ["--input-type=module", "-e", source]),
      spawn(process.execPath, ["--input-type=module", "-e", source]),
    ];
    await fs.promises.writeFile(gate, "go\n");
    const statuses = await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.once("close", resolve);
          }),
      ),
    );
    assert.deepEqual(statuses.sort(), [0, 2]);
  });
});

test("lease handoff records the verified new owner", async () => {
  await withTempLease(async (leasePath) => {
    const lease = await acquireLease(leasePath, { name: "handoff" });
    await transferLease(lease, {
      ownerPid: process.pid,
      ownerStartToken: procStartToken(process.pid),
      phase: "supervisor",
    });
    const base = JSON.parse(await fs.promises.readFile(leasePath, "utf8"));
    const owner = JSON.parse(
      await fs.promises.readFile(`${leasePath}.${lease.token}.owner`, "utf8"),
    );
    const record = { ...base, ...owner };
    assert.equal(record.phase, "supervisor");
    assert.equal(inspectLeaseOwner(record), "owned");
    await releaseLease(leaseReference(lease));
  });
});

test("a positively dead owner can be recovered", async () => {
  await withTempLease(async (leasePath) => {
    await fs.promises.writeFile(
      leasePath,
      `${JSON.stringify({
        version: 1,
        name: "stale",
        token: "stale-token",
        ownerPid: 2_000_000_000,
        ownerStartToken: "1",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    let reconciled = false;
    const lease = await acquireLease(leasePath, {
      name: "stale",
      waitMs: 1000,
      canRecover: async () => {
        reconciled = true;
        return true;
      },
    });
    assert.equal(reconciled, true);
    await releaseLease(leaseReference(lease));
  });
});

test("an unverified owner fails closed", async () => {
  for (const ownerPid of [process.pid, 2_000_000_000, undefined]) {
    await withTempLease(async (leasePath) => {
      await fs.promises.writeFile(
        leasePath,
        `${JSON.stringify({
          version: 1,
          name: "unverified",
          token: "unverified-token",
          ownerPid,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      await assert.rejects(
        acquireLease(leasePath, { name: "unverified", waitMs: 0 }),
        /owner identity is unverified/,
      );
    });
  }
});

test("an abandoned recovery guard is reclaimed only after owner death is proven", async () => {
  await withTempLease(async (leasePath) => {
    await fs.promises.writeFile(
      `${leasePath}.recovery`,
      `${JSON.stringify({
        version: 1,
        name: "test:recovery",
        token: "dead-recovery",
        ownerPid: 2_000_000_000,
        ownerStartToken: "1",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const lease = await acquireLease(leasePath, {
      name: "test",
      waitMs: 1000,
    });
    assert.equal(fs.existsSync(`${leasePath}.recovery`), false);
    await releaseLease(leaseReference(lease));
  });
});
