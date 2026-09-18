import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createApprovalRequest,
  listPendingApprovals,
  readApprovalRequest,
  resolveApprovalRequest,
  waitForApprovalResponse,
} from "../approval.ts";

async function withApprovalRoot(run) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-security-approval-"),
  );
  try {
    await run(root);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function createRequest(root, overrides = {}) {
  return createApprovalRequest(root, {
    jobId: "job-1",
    ruleName: "dangerous-command",
    reason: "Needs confirmation",
    detail: "rm -r build",
    toolName: "bash",
    input: { command: "rm -r build" },
    command: "rm -r build",
    ...overrides,
  });
}

test("approval response is bound to one request, job, and input digest", async () => {
  await withApprovalRoot(async (root) => {
    const request = await createRequest(root);
    assert.deepEqual(
      (await listPendingApprovals(root)).map((item) => item.id),
      [request.id],
    );

    await assert.rejects(
      resolveApprovalRequest(root, request.id, "another-job", "allow"),
      /belongs to another job/,
    );

    const response = await resolveApprovalRequest(
      root,
      request.id,
      request.jobId,
      "allow",
    );
    assert.equal(response.inputDigest, request.inputDigest);
    assert.equal(
      (await waitForApprovalResponse(root, request)).decision,
      "allow",
    );
    assert.deepEqual(await listPendingApprovals(root), []);
    await assert.rejects(
      resolveApprovalRequest(root, request.id, request.jobId, "deny"),
      /already resolved/,
    );
  });
});

test("approval denial is returned to the waiting child", async () => {
  await withApprovalRoot(async (root) => {
    const request = await createRequest(root);
    await resolveApprovalRequest(root, request.id, request.jobId, "deny");
    const response = await waitForApprovalResponse(root, request);
    assert.equal(response.decision, "deny");
  });
});

test("request file and content IDs must remain bound", async () => {
  await withApprovalRoot(async (root) => {
    const request = await createRequest(root);
    const requestPath = path.join(root, `${request.id}.request.json`);
    const tampered = {
      ...request,
      id: "00000000-0000-4000-8000-000000000000",
    };
    await fs.promises.writeFile(requestPath, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      readApprovalRequest(root, request.id),
      /file binding failed/,
    );
    assert.deepEqual(await listPendingApprovals(root), []);
  });
});

test("tampered approval response fails closed", async () => {
  await withApprovalRoot(async (root) => {
    const request = await createRequest(root);
    await fs.promises.writeFile(
      path.join(root, `${request.id}.response.json`),
      `${JSON.stringify({
        version: 1,
        requestId: request.id,
        jobId: request.jobId,
        inputDigest: "wrong",
        decision: "allow",
        decidedAt: new Date(0).toISOString(),
      })}\n`,
    );
    await assert.rejects(
      waitForApprovalResponse(root, request),
      /response binding failed/,
    );
  });
});

test("expired and aborted approval waits fail closed without polling delays", async () => {
  await withApprovalRoot(async (root) => {
    const expired = await createRequest(root);
    expired.expiresAt = new Date(0).toISOString();
    await assert.rejects(waitForApprovalResponse(root, expired), /timed out/);

    const aborted = await createRequest(root, { jobId: "job-2" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      waitForApprovalResponse(root, aborted, controller.signal),
      /aborted/,
    );
  });
});

test("approval request bounds display text without weakening exact binding", async () => {
  await withApprovalRoot(async (root) => {
    const longCommand = "x".repeat(20_000);
    const request = await createRequest(root, {
      command: longCommand,
      input: { command: longCommand },
    });
    assert.ok(request.command.length <= 8192);
    assert.match(request.command, /display truncated/);
    assert.equal(request.inputDigest.length, 64);
  });
});
