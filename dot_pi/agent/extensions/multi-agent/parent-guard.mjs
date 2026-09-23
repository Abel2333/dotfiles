import * as path from "node:path";

export const PARENT_GUARDED_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "python",
  "edit",
  "write",
]);

/** Broad exploration calls allowed after a delegated result in one user turn. */
export const EXPLORATION_BUDGET_LIMIT = 4;

const EXPLORATION_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const TERMINAL_JOB_STATES = new Set([
  "completed",
  "failed",
  "aborted",
  "orphaned",
]);
const SUPPORTED_ROLES = new Set([
  "scout",
  "feasibility",
  "reviewer",
  "implementer",
]);
const WORKFLOW_ROLES = new Set(["reviewer", "implementer"]);
const JOB_REFERENCE_ACTIONS = new Set([
  "start",
  "status",
  "wait",
  "wait_many",
  "result",
  "abort",
  "authorize",
]);
const READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "fd",
  "rg",
  "grep",
  "git",
  "stat",
  "file",
  "wc",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "realpath",
  "readlink",
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "cat-file",
  "name-rev",
  "describe",
]);
const GIT_SIDE_EFFECT_FLAGS = new Set([
  "-c",
  "--config-env",
  "--ext-diff",
  "--textconv",
  "--output",
]);
const FIND_EXEC_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const FD_EXEC_FLAGS = new Set(["-x", "--exec", "-X", "--exec-batch"]);
const VERIFICATION_MODULES = new Set(["pytest", "mypy"]);
const PACKAGE_SCRIPTS = new Set(["test", "lint", "typecheck"]);
const PACKAGE_BINARIES = new Set(["vitest", "tsc"]);
const NODE_EVAL_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);
const TIMEOUT_FLAGS = new Set([
  "-v",
  "--verbose",
  "--foreground",
  "--preserve-status",
]);

function asObject(value) {
  return value && typeof value === "object" ? value : undefined;
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function shellWords(segment) {
  return (
    segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripQuotes) ?? []
  );
}

function findGitSubcommand(words) {
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (
      word === "-C" ||
      word === "-c" ||
      word === "--git-dir" ||
      word === "--work-tree" ||
      word === "--config-env"
    ) {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    return word;
  }
  return undefined;
}

function hasGitSideEffectFlag(words) {
  return words.some(
    (word) =>
      GIT_SIDE_EFFECT_FLAGS.has(word) ||
      word.startsWith("--config-env=") ||
      word.startsWith("--output=") ||
      (word.startsWith("-c") && word.length > 2 && !word.startsWith("--")),
  );
}

function hasFindExecFlag(words) {
  return words.some((word) => FIND_EXEC_FLAGS.has(word));
}

function hasFdExecFlag(words) {
  return words.some(
    (word) =>
      FD_EXEC_FLAGS.has(word) ||
      word.startsWith("--exec=") ||
      word.startsWith("--exec-batch=") ||
      (word.startsWith("-x") && word.length > 2),
  );
}

function actionFromInput(input) {
  const value = asObject(input);
  if (!value) return undefined;
  if (typeof value.action === "string") return value.action;
  if (value.agent || value.task || Array.isArray(value.tasks)) return "start";
  return undefined;
}

function startRoles(input) {
  if (actionFromInput(input) !== "start") return [];
  const value = asObject(input);
  if (!value) return [];
  const roles = [];
  const single = asNonEmptyString(value.agent);
  if (single && SUPPORTED_ROLES.has(single)) roles.push(single);
  if (Array.isArray(value.tasks)) {
    for (const task of value.tasks) {
      const role = asNonEmptyString(asObject(task)?.agent);
      if (role && SUPPORTED_ROLES.has(role)) roles.push(role);
    }
  }
  return [...new Set(roles)];
}

function toolResultIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    const message = asObject(entry)?.message;
    if (asObject(entry)?.type !== "message" || message?.role !== "toolResult") {
      continue;
    }
    const id = asNonEmptyString(message.toolCallId);
    if (id) ids.add(id);
  }
  return ids;
}

function pendingStartCalls(entries) {
  const completed = toolResultIds(entries);
  const pending = [];
  for (const entry of entries) {
    const message = asObject(entry)?.message;
    if (asObject(entry)?.type !== "message" || message?.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = asObject(block);
      if (call?.type !== "toolCall" || call.name !== "subagent") continue;
      const id = asNonEmptyString(call.id);
      const roles = startRoles(call.arguments);
      if (!id || roles.length === 0 || completed.has(id)) continue;
      pending.push({ id, roles });
    }
  }
  return pending;
}

function snapshotJob(snapshot) {
  const job = asObject(asObject(snapshot)?.job);
  const id = asNonEmptyString(job?.id);
  const agent = asNonEmptyString(job?.agent);
  const state = asNonEmptyString(job?.state);
  if (!id || !agent || !state || !SUPPORTED_ROLES.has(agent)) return undefined;
  return { id, agent, state };
}

function jobSnapshots(details) {
  const value = asObject(details);
  if (!value || !JOB_REFERENCE_ACTIONS.has(value.action)) return [];
  if (!Array.isArray(value.jobs)) return [];
  return value.jobs.map(snapshotJob).filter(Boolean);
}

function deriveDelegationState(jobs, pendingStarts, startedJobIds) {
  const activeJobs = jobs.filter(
    (job) => !TERMINAL_JOB_STATES.has(job.state),
  );
  const workflowJobs = jobs.filter(
    (job) => startedJobIds.has(job.id) && WORKFLOW_ROLES.has(job.agent),
  );
  const pendingWorkflowStarts = pendingStarts.filter((start) =>
    start.roles.some((role) => WORKFLOW_ROLES.has(role)),
  );
  const implementers = jobs.filter(
    (job) => startedJobIds.has(job.id) && job.agent === "implementer",
  );
  let lastCompletedImplementer = -1;
  implementers.forEach((job, index) => {
    if (job.state === "completed") lastCompletedImplementer = index;
  });
  const failedImplementerJobIds = implementers
    .slice(lastCompletedImplementer + 1)
    .filter((job) => job.state === "failed" || job.state === "orphaned")
    .map((job) => job.id);

  return {
    jobs,
    startedJobIds,
    activeJobs,
    pendingStarts,
    workflowJobs,
    pendingWorkflowStarts,
    failedImplementerJobIds,
  };
}

/**
 * Return the active branch suffix belonging to the current user turn.
 *
 * Test and legacy branches without a user message are treated as one turn so a
 * missing historical entry cannot silently weaken the parent write boundary.
 */
export function currentUserTurnEntries(entries) {
  const branch = Array.isArray(entries) ? entries : [];
  let start = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = asObject(branch[index]);
    if (entry?.type === "message" && entry.message?.role === "user") {
      start = index;
      break;
    }
  }
  return start < 0 ? branch : branch.slice(start);
}

/**
 * Collect current-branch jobs and unresolved starts without consulting global job state.
 *
 * Only jobs created by a retained start result establish branch ownership. This
 * prevents a status lookup for an unrelated session from changing a parent's tool
 * permissions. Implementer failures remain unresolved until a later implementer
 * completes, so the continuation lock survives later user messages.
 */
export function collectBranchDelegation(entries) {
  const branch = Array.isArray(entries) ? entries : [];
  const branchJobIds = new Set();
  const startedJobIds = new Set();
  const observedSnapshots = [];

  for (const entry of branch) {
    const message = asObject(asObject(entry)?.message);
    if (
      asObject(entry)?.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "subagent"
    ) {
      continue;
    }
    const action = actionFromInput(message.details);
    const snapshots = jobSnapshots(message.details);
    observedSnapshots.push(snapshots);
    if (action !== "start") continue;
    for (const job of snapshots) {
      branchJobIds.add(job.id);
      startedJobIds.add(job.id);
    }
  }

  const jobs = new Map();
  for (const snapshots of observedSnapshots) {
    for (const job of snapshots) {
      if (branchJobIds.has(job.id)) jobs.set(job.id, job);
    }
  }

  const pendingStarts = pendingStartCalls(branch);
  return deriveDelegationState(
    [...jobs.values()],
    pendingStarts,
    startedJobIds,
  );
}

/**
 * Refresh branch-owned job snapshots against retained job state.
 *
 * A resolver returning undefined marks the reference as cleaned or unknown and
 * drops it, so a historical running snapshot cannot lock the parent forever. A
 * resolver error keeps the last known snapshot, so an unrelated lookup failure
 * cannot clear a genuinely active job. Pending starts always survive refresh and
 * keep blocking same-batch siblings.
 */
export async function refreshBranchDelegation(state, options = {}) {
  const { resolveJob } = options;
  if (typeof resolveJob !== "function" || state.jobs.length === 0) return state;
  const jobs = [];
  for (const historical of state.jobs) {
    let live;
    try {
      live = await resolveJob(historical.id);
    } catch {
      jobs.push(historical);
      continue;
    }
    if (live === undefined || live === null) continue;
    jobs.push(snapshotJob(live) ?? historical);
  }
  return deriveDelegationState(jobs, state.pendingStarts, state.startedJobIds);
}

/** Return true when this extension instance runs inside a delegated child process. */
export function isChildMultiAgentProcess(env = process.env) {
  return Boolean(asNonEmptyString(env?.PI_MULTI_AGENT_ROLE));
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Report whether a write target is parent-owned workflow metadata.
 *
 * Plans are the only project-local metadata exception. Keeping this list narrow
 * prevents a workflow from bypassing the strict boundary through a broad
 * configuration-directory exception.
 */
export function isParentWorkflowMetadataPath(cwd, inputPath) {
  if (typeof cwd !== "string" || !cwd || typeof inputPath !== "string") {
    return false;
  }
  const raw = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const target = path.resolve(cwd, raw);
  return pathInside(path.resolve(cwd, "plans"), target);
}

/** Return true for shell commands that are constrained to inspection only. */
export function isReadOnlyBash(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/\n|\r|>|<|`|\$\(|\$\{|(?<!&)&(?!&)|\(|\)/.test(command)) {
    return false;
  }

  const segments = command.split(/\|\||&&|\||;/).map((item) => item.trim());
  if (segments.some((item) => item.length === 0)) return false;

  for (const segment of segments) {
    const words = shellWords(segment);
    const executable = path.basename(words[0] ?? "");
    if (!READ_ONLY_COMMANDS.has(executable)) return false;
    if (executable === "git") {
      if (hasGitSideEffectFlag(words)) return false;
      const subcommand = findGitSubcommand(words);
      if (!subcommand || !READ_ONLY_GIT_COMMANDS.has(subcommand)) return false;
    }
    if (executable === "find" && hasFindExecFlag(words)) return false;
    if (executable === "fd" && hasFdExecFlag(words)) return false;
    if (
      executable === "rg" &&
      words.some((word) => word === "--pre" || word.startsWith("--pre="))
    ) {
      return false;
    }
    if (
      executable === "sort" &&
      words.some(
        (word) =>
          word === "-o" || word === "--output" || word.startsWith("--output="),
      )
    ) {
      return false;
    }
  }
  return true;
}

function hasForbiddenVerificationFlag(words) {
  return words.some(
    (word) =>
      word === "--fix" ||
      word.startsWith("--fix=") ||
      NODE_EVAL_FLAGS.has(word) ||
      word.startsWith("--eval=") ||
      word.startsWith("--print=") ||
      word.startsWith("--require=") ||
      word.startsWith("--import="),
  );
}

function isPythonModuleInvocation(executable, args) {
  return (
    (executable === "python" || executable === "python3") &&
    args[0] === "-m" &&
    VERIFICATION_MODULES.has(args[1])
  );
}

function isRuffInvocation(args) {
  if (args[0] === "check") return true;
  if (args[0] === "format") return args.includes("--check");
  return false;
}

function isBareVerificationInvocation(words) {
  if (words.length === 0) return false;
  const executable = path.basename(words[0]);
  const args = words.slice(1);
  if (executable === "pytest" || executable === "mypy") return true;
  if (executable === "ruff") return isRuffInvocation(args);
  return isPythonModuleInvocation(executable, args);
}

function isUvInvocation(args) {
  if (args[0] !== "run") return false;
  let index = 1;
  while (index < args.length) {
    const word = args[index];
    if (word === "--project") {
      if (index + 1 >= args.length) return false;
      index += 2;
      continue;
    }
    if (word.startsWith("--project=")) {
      index += 1;
      continue;
    }
    break;
  }
  const inner = args.slice(index);
  if (inner.length === 0) return false;
  return isBareVerificationInvocation(inner);
}

function isPackageManagerInvocation(executable, args) {
  const command = args.find((arg) => !arg.startsWith("-"));
  if (command === undefined) return false;
  if (executable === "npx") {
    if (command === "vitest") return true;
    if (command === "tsc") return args.includes("--noEmit");
    return false;
  }
  if (command === "run") {
    const script = args[args.indexOf(command) + 1];
    if (PACKAGE_SCRIPTS.has(script)) return true;
    if (PACKAGE_BINARIES.has(script)) {
      return script === "vitest" ? true : args.includes("--noEmit");
    }
    return false;
  }
  if (PACKAGE_SCRIPTS.has(command)) return true;
  if (PACKAGE_BINARIES.has(command)) {
    return command === "vitest" ? true : args.includes("--noEmit");
  }
  return false;
}

function isTestInvocation(words) {
  if (words.length === 0) return false;
  const executable = path.basename(words[0]);
  const args = words.slice(1);
  if (hasForbiddenVerificationFlag(args)) return false;
  if (executable === "node" || executable === "bun") {
    return args.includes("--test") || args.includes("--check");
  }
  if (executable === "uv") return isUvInvocation(args);
  if (
    executable === "npm" ||
    executable === "pnpm" ||
    executable === "yarn" ||
    executable === "npx"
  ) {
    return isPackageManagerInvocation(executable, args);
  }
  if (
    executable === "pytest" ||
    executable === "mypy" ||
    executable === "ruff" ||
    executable === "python" ||
    executable === "python3"
  ) {
    return isBareVerificationInvocation(words);
  }
  if (executable === "cargo" || executable === "go") {
    return args[0] === "test";
  }
  if (executable === "make" || executable === "just") {
    return args[0] === "test";
  }
  return false;
}

function timeoutInnerWords(args) {
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (!word.startsWith("-")) break;
    if (TIMEOUT_VALUE_OPTIONS.has(word)) {
      if (index + 1 >= args.length) return undefined;
      index += 2;
      continue;
    }
    if (word.startsWith("--signal=") || word.startsWith("--kill-after=")) {
      index += 1;
      continue;
    }
    if (TIMEOUT_FLAGS.has(word)) {
      index += 1;
      continue;
    }
    return undefined;
  }
  if (index >= args.length) return undefined;
  if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[index])) return undefined;
  const inner = args.slice(index + 1);
  return inner.length ? inner : undefined;
}

/**
 * Permit one narrow verification command, optionally prefixed by a single
 * `cd <dir> &&`, and `timeout` wrapping one test invocation.
 *
 * Any further chaining, piping, redirection, substitution, subshell, or
 * background syntax is rejected so a verification allowlist entry cannot smuggle
 * a second command.
 */
export function isNarrowVerificationBash(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/[\n\r`<>()]/.test(command)) return false;
  if (/\$\(|\$\{/.test(command)) return false;
  if (/[|;]/.test(command)) return false;

  const segments = command.split("&&");
  const ampersands = (command.match(/&/g) ?? []).length;
  if (segments.length > 2 || ampersands !== (segments.length - 1) * 2) {
    return false;
  }

  let rest = command.trim();
  if (segments.length === 2) {
    const prefix = shellWords(segments[0].trim());
    if (prefix.length !== 2 || prefix[0] !== "cd") return false;
    rest = segments[1].trim();
    if (!rest) return false;
  }

  const words = shellWords(rest);
  if (words.length === 0) return false;
  const executable = path.basename(words[0]);
  if (executable === "timeout") {
    const inner = timeoutInnerWords(words.slice(1));
    return inner !== undefined && isTestInvocation(inner);
  }
  return isTestInvocation(words);
}

function activeJobLabels(state) {
  return [
    ...state.activeJobs.map((job) => `${job.id} (${job.agent}:${job.state})`),
    ...state.pendingStarts.map(
      (start) => `pending start ${start.id} (${start.roles.join(",")})`,
    ),
  ];
}

function activeJobBlockReason(state) {
  return [
    `Parent broad tool use is blocked while current-branch subagent job(s) are non-terminal: ${activeJobLabels(state).join(", ")}.`,
    "Use subagent action=wait (wait_many for two jobs) to observe the work until it finishes; avoid repeated status polling and use status, result, or authorize only for snapshots, output, or approvals.",
  ].join(" ");
}

function workflowBlockReason(state, toolName) {
  const reviewerStarted = [
    ...state.workflowJobs.map((job) => job.agent),
    ...state.pendingWorkflowStarts.flatMap((start) => start.roles),
  ].includes("reviewer");
  let guidance;
  if (state.failedImplementerJobIds.length) {
    guidance = [
      `Implementer job(s) ${state.failedImplementerJobIds.join(", ")} failed or became orphaned.`,
      "Start a continuation implementer with the approved plan; parent project edits remain blocked.",
    ].join(" ");
  } else if (reviewerStarted) {
    guidance = [
      "Reviewer findings must be sent to a remediation implementer limited to parent-accepted Finding IDs;",
      "parent project edits remain blocked.",
    ].join(" ");
  } else {
    guidance = [
      "Use a new implementer with the approved plan or a remediation implementer with only parent-accepted Finding IDs;",
      "parent project edits remain blocked.",
    ].join(" ");
  }
  return [
    `Parent ${toolName} is blocked after a delegated implementation or review workflow started in this user turn.`,
    guidance,
    "Use /agent-mode direct only for an intentional user override.",
  ].join(" ");
}

function explorationBlockReason() {
  return [
    `Parent broad exploration is blocked after a delegated result in this user turn (${EXPLORATION_BUDGET_LIMIT} direct broad calls allowed).`,
    "Start a targeted scout with subagent action=start (agent=scout) for deeper exploration,",
    "or use narrow test/lint commands and plans/ updates directly.",
  ].join(" ");
}

function terminalResultMarker(entries) {
  const branch = Array.isArray(entries) ? entries : [];
  let marker;
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    const message = asObject(asObject(entry)?.message);
    if (
      asObject(entry)?.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "subagent"
    ) {
      continue;
    }
    const snapshots = jobSnapshots(message.details);
    if (snapshots.some((job) => TERMINAL_JOB_STATES.has(job.state))) {
      marker = asNonEmptyString(asObject(entry)?.id) ?? `entry-${index}`;
    }
  }
  return marker;
}

function explorationTargetsWorkflowMetadata(toolName, input, cwd) {
  if (!EXPLORATION_TOOL_NAMES.has(toolName)) return false;
  return isParentWorkflowMetadataPath(cwd, asObject(input)?.path);
}

/**
 * Evaluate a parent tool call against current-branch delegation boundaries.
 *
 * Direct mode is an explicit session-local user override. Delegated child
 * processes bypass parent boundaries through their environment. `resolveJob`
 * refreshes branch-owned snapshots against retained job state; `explorationBudget`
 * is a caller-owned counter shared across tool calls in the session.
 */
export async function evaluateParentToolCall(event, options = {}) {
  const {
    branch = [],
    cwd = process.cwd(),
    mode = "strict",
    env = process.env,
    resolveJob,
    explorationBudget,
  } = options;
  if (mode === "direct" || isChildMultiAgentProcess(env)) return undefined;

  const toolName = typeof event?.toolName === "string" ? event.toolName : "";
  const input = asObject(event?.input);

  // Plans are parent-owned workflow metadata: they stay writable even while a
  // delegated job is active, so this exemption precedes active-job blocking.
  if (
    (toolName === "edit" || toolName === "write") &&
    isParentWorkflowMetadataPath(cwd, input?.path)
  ) {
    return undefined;
  }

  const turnEntries = currentUserTurnEntries(branch);
  const terminalMarker = terminalResultMarker(turnEntries);
  const exploration =
    EXPLORATION_TOOL_NAMES.has(toolName) ||
    (toolName === "bash" && isReadOnlyBash(input?.command));
  let explorationSlot = 0;
  if (
    explorationBudget &&
    terminalMarker !== undefined &&
    exploration &&
    !explorationTargetsWorkflowMetadata(toolName, input, cwd)
  ) {
    if (explorationBudget.marker !== terminalMarker) {
      explorationBudget.marker = terminalMarker;
      explorationBudget.used = 0;
    }
    explorationBudget.used += 1;
    explorationSlot = explorationBudget.used;
  }

  const branchState = await refreshBranchDelegation(
    collectBranchDelegation(branch),
    { resolveJob },
  );
  const turnState = await refreshBranchDelegation(
    collectBranchDelegation(turnEntries),
    { resolveJob },
  );

  if (
    PARENT_GUARDED_TOOL_NAMES.has(toolName) &&
    (branchState.activeJobs.length > 0 || branchState.pendingStarts.length > 0)
  ) {
    return {
      block: true,
      reason: activeJobBlockReason(branchState),
      state: branchState,
    };
  }

  const failedImplementerJobIds = branchState.failedImplementerJobIds;
  const workflowBlocked =
    turnState.workflowJobs.length > 0 ||
    turnState.pendingWorkflowStarts.length > 0 ||
    failedImplementerJobIds.length > 0;
  const workflowState = { ...turnState, failedImplementerJobIds };

  if (toolName === "bash") {
    if (isReadOnlyBash(input?.command)) {
      return explorationSlot > EXPLORATION_BUDGET_LIMIT
        ? { block: true, reason: explorationBlockReason(), state: workflowState }
        : undefined;
    }
    if (isNarrowVerificationBash(input?.command)) return undefined;
    return workflowBlocked
      ? {
          block: true,
          reason: workflowBlockReason(workflowState, toolName),
          state: workflowState,
        }
      : undefined;
  }

  if (toolName === "powershell" || toolName === "python") {
    return workflowBlocked
      ? {
          block: true,
          reason: workflowBlockReason(workflowState, toolName),
          state: workflowState,
        }
      : undefined;
  }

  if (toolName === "edit" || toolName === "write") {
    return workflowBlocked
      ? {
          block: true,
          reason: workflowBlockReason(workflowState, toolName),
          state: workflowState,
        }
      : undefined;
  }

  if (EXPLORATION_TOOL_NAMES.has(toolName)) {
    return explorationSlot > EXPLORATION_BUDGET_LIMIT
      ? { block: true, reason: explorationBlockReason(), state: workflowState }
      : undefined;
  }

  return undefined;
}
