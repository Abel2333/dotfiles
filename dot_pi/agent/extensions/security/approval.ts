import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Default lifetime for a parent-mediated authorization request. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";
const MAX_COMMAND_CHARS = 8192;
const MAX_PATH_CHARS = 2048;
const MAX_TEXT_CHARS = 2048;

/** A one-shot authorization request emitted by a headless child session. */
export interface ApprovalRequest {
  version: 1;
  id: string;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  ruleName: string;
  reason: string;
  detail: string;
  toolName: string;
  inputDigest: string;
  command?: string;
  path?: string;
  explanation?: string;
}

/** The parent session's response to one exact authorization request. */
export interface ApprovalResponse {
  version: 1;
  requestId: string;
  jobId: string;
  inputDigest: string;
  decision: "allow" | "deny";
  decidedAt: string;
}

/** Inputs needed to bind and display one delegated authorization request. */
export interface CreateApprovalOptions {
  jobId: string;
  ruleName: string;
  reason: string;
  detail: string;
  toolName: string;
  input: unknown;
  command?: string;
  path?: string;
  explanation?: string;
  timeoutMs?: number;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 24))}\n[display truncated]`;
}

function approvalPath(root: string, id: string, suffix: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`Invalid approval request ID: ${id}`);
  }
  return path.join(root, `${id}${suffix}`);
}

function requestPath(root: string, id: string): string {
  return approvalPath(root, id, REQUEST_SUFFIX);
}

function responsePath(root: string, id: string): string {
  return approvalPath(root, id, RESPONSE_SUFFIX);
}

async function publishJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.candidate`;
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
}

function inputDigest(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({ toolName, input }) ?? "undefined";
  } catch {
    serialized = String(input);
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validateRequest(value: ApprovalRequest): ApprovalRequest {
  if (
    value?.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.id) ||
    typeof value.jobId !== "string" ||
    !value.jobId ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.ruleName !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.detail !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.inputDigest !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.inputDigest) ||
    !isOptionalString(value.command) ||
    !isOptionalString(value.path) ||
    !isOptionalString(value.explanation)
  ) {
    throw new Error("Malformed approval request");
  }
  return value;
}

function validateResponse(
  value: ApprovalResponse,
  request: ApprovalRequest,
): ApprovalResponse {
  if (
    value?.version !== 1 ||
    value.requestId !== request.id ||
    value.jobId !== request.jobId ||
    value.inputDigest !== request.inputDigest ||
    (value.decision !== "allow" && value.decision !== "deny")
  ) {
    throw new Error(
      `Approval response binding failed for request ${request.id}`,
    );
  }
  return value;
}

async function readResponse(
  root: string,
  request: ApprovalRequest,
): Promise<ApprovalResponse | undefined> {
  try {
    return validateResponse(
      await readJson<ApprovalResponse>(responsePath(root, request.id)),
      request,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForDirectoryChange(
  root: string,
  fileName: string,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Approval wait aborted");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Approval wait aborted"));
    const timer = setTimeout(
      () => finish(),
      Math.max(1, Math.min(maxWaitMs, 1000)),
    );
    try {
      watcher = fs.watch(root, { persistent: false }, (_event, changed) => {
        if (!changed || changed.toString() === fileName) finish();
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Persist a bounded request for one exact tool call.
 *
 * @param root Per-job approval directory.
 * @param options Rule and tool-call details used for display and binding.
 * @returns The persisted request.
 */
export async function createApprovalRequest(
  root: string,
  options: CreateApprovalOptions,
): Promise<ApprovalRequest> {
  const now = Date.now();
  const request: ApprovalRequest = {
    version: 1,
    id: randomUUID(),
    jobId: options.jobId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      now + Math.max(0, options.timeoutMs ?? APPROVAL_TIMEOUT_MS),
    ).toISOString(),
    ruleName: bounded(options.ruleName, MAX_TEXT_CHARS) ?? "unknown",
    reason: bounded(options.reason, MAX_TEXT_CHARS) ?? "",
    detail: bounded(options.detail, MAX_TEXT_CHARS) ?? "",
    toolName: options.toolName,
    inputDigest: inputDigest(options.toolName, options.input),
    command: bounded(options.command, MAX_COMMAND_CHARS),
    path: bounded(options.path, MAX_PATH_CHARS),
    explanation: bounded(options.explanation, MAX_TEXT_CHARS),
  };
  await publishJson(requestPath(root, request.id), request);
  return request;
}

/**
 * Read one retained authorization request.
 *
 * @param root Per-job approval directory.
 * @param requestId Request identifier.
 * @returns The validated request.
 */
export async function readApprovalRequest(
  root: string,
  requestId: string,
): Promise<ApprovalRequest> {
  const request = validateRequest(
    await readJson<ApprovalRequest>(requestPath(root, requestId)),
  );
  if (request.id !== requestId) {
    throw new Error(`Approval request file binding failed for ${requestId}`);
  }
  return request;
}

/**
 * List unresolved and unexpired requests for a retained job.
 *
 * @param root Per-job approval directory.
 * @returns Pending requests ordered by creation time.
 */
export async function listPendingApprovals(
  root: string,
): Promise<ApprovalRequest[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const pending: ApprovalRequest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
    const id = entry.name.slice(0, -REQUEST_SUFFIX.length);
    try {
      const request = await readApprovalRequest(root, id);
      if (Date.parse(request.expiresAt) <= Date.now()) continue;
      try {
        await fs.promises.access(responsePath(root, id));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      pending.push(request);
    } catch {
      // Leave malformed records for diagnosis, but never present them for approval.
    }
  }
  return pending.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/**
 * Record a one-shot parent decision bound to the retained request.
 *
 * @param root Per-job approval directory.
 * @param requestId Request identifier.
 * @param jobId Expected owning job.
 * @param decision Parent decision.
 * @returns The persisted response.
 */
export async function resolveApprovalRequest(
  root: string,
  requestId: string,
  jobId: string,
  decision: "allow" | "deny",
): Promise<ApprovalResponse> {
  const request = await readApprovalRequest(root, requestId);
  if (request.jobId !== jobId)
    throw new Error(`Approval request ${requestId} belongs to another job`);
  if (Date.parse(request.expiresAt) <= Date.now())
    throw new Error(`Approval request ${requestId} has expired`);
  try {
    await fs.promises.access(responsePath(root, requestId));
    throw new Error(`Approval request ${requestId} is already resolved`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response: ApprovalResponse = {
    version: 1,
    requestId,
    jobId,
    inputDigest: request.inputDigest,
    decision,
    decidedAt: new Date().toISOString(),
  };
  try {
    await publishJson(responsePath(root, requestId), response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Approval request ${requestId} is already resolved`);
    }
    throw error;
  }
  return response;
}

/**
 * Wait for the parent decision until expiration or cancellation.
 *
 * @param root Per-job approval directory.
 * @param request Request being resolved.
 * @param signal Child tool-call cancellation signal.
 * @returns The validated parent response.
 * @throws {Error} On timeout, cancellation, malformed response, or binding mismatch.
 */
export async function waitForApprovalResponse(
  root: string,
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  const fileName = path.basename(responsePath(root, request.id));
  for (;;) {
    const response = await readResponse(root, request);
    if (response) return response;
    const remaining = Date.parse(request.expiresAt) - Date.now();
    if (remaining <= 0)
      throw new Error(`Approval request ${request.id} timed out`);
    await waitForDirectoryChange(root, fileName, remaining, signal);
  }
}
