import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const configuredAgentDir = path.resolve(getAgentDir());
fs.mkdirSync(configuredAgentDir, { recursive: true, mode: 0o700 });

/** Canonical agent state root shared by all multi-agent lease users. */
export const AGENT_DIR = fs.realpathSync.native(configuredAgentDir);

/** Canonical directory for multi-agent durable state. */
export const MULTI_AGENT_STATE_DIR = path.join(AGENT_DIR, "multi-agent");

/** Canonical directory for multi-agent lease files. */
export const MULTI_AGENT_LEASE_DIR = path.join(
  MULTI_AGENT_STATE_DIR,
  "leases",
);

function pathKey(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolve an existing resource path to its canonical physical identity.
 *
 * @param {string} value Existing path to canonicalize.
 * @returns {Promise<string>} Canonical absolute path.
 */
export async function canonicalResourcePath(value) {
  return fs.promises.realpath(path.resolve(value));
}

/**
 * Resolve a path inside a Git checkout to its canonical worktree root.
 *
 * @param {string} value Existing path inside the target Git worktree.
 * @returns {Promise<string>} Canonical top-level directory for that worktree.
 * @throws When the path is not inside a Git worktree or cannot be resolved.
 */
export async function canonicalGitWorktreeRoot(value) {
  const resolved = await canonicalResourcePath(value);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", resolved, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  return canonicalResourcePath(stdout.trim());
}

/**
 * Return the lease path protecting one canonical Git worktree root.
 *
 * @param {string} canonicalRoot Canonical worktree root.
 * @returns {string} Stable lease file path.
 */
export function worktreeWriterLeasePath(canonicalRoot) {
  return path.join(
    MULTI_AGENT_LEASE_DIR,
    `worktree-writer-${pathKey(canonicalRoot)}.lock`,
  );
}

/**
 * Return the lease path serializing metadata operations for one Git common dir.
 *
 * @param {string} canonicalCommonDir Canonical Git common directory.
 * @returns {string} Stable lease file path.
 */
export function gitMetadataLeasePath(canonicalCommonDir) {
  return path.join(
    MULTI_AGENT_LEASE_DIR,
    `git-metadata-${pathKey(canonicalCommonDir)}.lock`,
  );
}
