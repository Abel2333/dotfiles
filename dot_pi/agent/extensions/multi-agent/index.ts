import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ApprovalRequest } from "../security/approval";
import { writeLog } from "../security/logger";
import { findAgent } from "./agents";
import { evaluateParentToolCall } from "./parent-guard.mjs";
import {
  abortJob,
  acquireFeasibilityLease,
  acquireImplementerLeases,
  cleanupJob,
  createJobId,
  findActiveJobUsingWorkspace,
  findJobUsingWorkspace,
  getJobResult,
  getJobSnapshot,
  hasActiveFeasibilityJob,
  listJobSnapshots,
  releaseUnstartedLease,
  releaseUnstartedLeases,
  resolveJobApproval,
  startJob,
  observeJobs,
} from "./jobs";
import { truncateUtf8 } from "./limits.mjs";
import {
  formatCompactSnapshots,
  formatResultContent,
  formatStatsSummary,
} from "./presentation.mjs";
import { requiresSingleDispatch, resolveAgentWorkspace } from "./policy.mjs";
import {
  aggregateParentUsage,
  aggregateSubagentStats,
  collectSubagentHistory,
} from "./stats.mjs";
import { assertImplementerTaskSafe } from "./task-policy.mjs";
import { normalizeWaitJobIds } from "./wait-policy.mjs";
import { resolveRoutedModel } from "./routing.mjs";
import { truncateOutput } from "./runner";
import {
  SUMMARY_MAX_CHARS,
  fallbackSummary,
  normalizeSummary,
} from "./summary.mjs";
import type {
  AgentConfig,
  AgentName,
  DelegatedTask,
  JobObservation,
  JobSnapshot,
  JobState,
  LeaseHandle,
  PreparedWorkspace,
  SubagentDetails,
  SubagentJobRecord,
  WorkspaceMode,
  WorkspaceRecord,
} from "./types";
import {
  cleanupWorkspace,
  inspectGitState,
  listWorkspaces,
  prepareWorkspace,
  pruneMissingWorkspaces,
  releasePreparedWorkspaceLease,
} from "./workspace";

const AGENT_NAMES = [
  "scout",
  "feasibility",
  "reviewer",
  "implementer",
] as const;
const WORKSPACE_MODES = ["research", "scratch", "worktree", "project"] as const;
const ACTIONS = [
  "start",
  "status",
  "wait",
  "wait_many",
  "result",
  "abort",
  "list",
  "authorize",
  "stats",
] as const;
const MAX_PARALLEL = 2;
const SUMMARY_SCHEMA = {
  maxLength: SUMMARY_MAX_CHARS,
  description:
    "One-line title (<= 160 chars) for the delegated task, shown to the user in the UI.",
};
const RESULT_DETAILS_CAP = 256 * 1024;
const GUARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "child-guard.ts",
);

const AgentSchema = StringEnum(AGENT_NAMES);
const JobStateSchema = StringEnum(
  ["queued", "running", "aborting", "completed", "failed", "aborted", "orphaned"] as const,
);
const WorkspaceSchema = StringEnum(WORKSPACE_MODES, {
  description:
    "research is read-only; scratch writes in /tmp; worktree writes in a detached Git worktree; project writes directly in the current Git repository",
});
const ActionSchema = StringEnum(ACTIONS, {
  description:
    "start, status, wait, wait_many, result, abort, list, authorize, or stats. Legacy start calls may omit action.",
});
const ResultViewSchema = StringEnum(["summary", "full"] as const, {
  description:
    "Result content view. summary is compact by default; full returns the existing bounded output.",
});

const ParallelTaskSchema = Type.Object({
  agent: AgentSchema,
  task: Type.String({ description: "Specific task delegated to the agent" }),
  summary: Type.String(SUMMARY_SCHEMA),
  model: Type.String({
    description:
      "Required for action=start. Pass the exact model for this task; the parent session model is valid too.",
  }),
  workspace: Type.Optional(WorkspaceSchema),
});

const SubagentParams = Type.Object({
  action: Type.Optional(ActionSchema),
  jobId: Type.Optional(
    Type.String({ description: "Full job ID or a unique job ID prefix" }),
  ),
  jobIds: Type.Optional(
    Type.Array(Type.String({ description: "Full job ID or unique prefix" }), {
      description:
        "One or two unique job IDs for action=wait_many; duplicates are collapsed before observation.",
    }),
  ),
  requestId: Type.Optional(
    Type.String({
      description:
        "Pending approval request ID or unique prefix for action=authorize",
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Observation window. A wait always lasts at least the selected role floor: scout 600s, reviewer/feasibility 1200s, implementer 1800s (mixed jobs use the longest). Shorter explicit values, including 0, are raised to that floor; a wait never terminates the child. Use action=status for a non-blocking snapshot.",
    }),
  ),
  stallSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Inactivity observation floor. A positive value is raised to the selected role floor: scout 600s, reviewer/feasibility 1200s, implementer 1800s (mixed jobs use the longest); 0 disables early stalled observation return.",
    }),
  ),
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Activity cursor for incremental result reads",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description: "Result or list page size; list defaults to 20 for history/filter queries",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Zero-based list page offset" }),
  ),
  history: Type.Optional(
    Type.Boolean({ description: "List retained history in pages instead of the default active-plus-five view" }),
  ),
  state: Type.Optional(JobStateSchema),
  session: Type.Optional(
    Type.String({ description: "Filter list by child session directory, path, or job ID (exact match)" }),
  ),
  view: Type.Optional(ResultViewSchema),
  agent: Type.Optional(AgentSchema),
  task: Type.Optional(Type.String()),
  summary: Type.Optional(
    Type.String({
      ...SUMMARY_SCHEMA,
      description:
        "One-line title (<= 160 chars) for the delegated task, shown to the user in the UI. Required for action=start.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Required for action=start. Pass the exact model for the task; the parent session model is valid too.",
    }),
  ),
  workspace: Type.Optional(WorkspaceSchema),
  tasks: Type.Optional(
    Type.Array(ParallelTaskSchema, {
      maxItems: MAX_PARALLEL,
      description:
        "Up to two parallel read-only scout or reviewer tasks. Writable roles require single-task dispatch.",
    }),
  ),
});

type SubagentParamsType = {
  action?: (typeof ACTIONS)[number];
  jobId?: string;
  jobIds?: string[];
  requestId?: string;
  waitSeconds?: number;
  stallSeconds?: number;
  cursor?: number;
  limit?: number;
  offset?: number;
  history?: boolean;
  state?: JobState;
  session?: string;
  view?: "summary" | "full";
  agent?: AgentName;
  task?: string;
  summary?: string;
  model?: string;
  workspace?: WorkspaceMode;
  tasks?: Array<{
    agent: AgentName;
    task: string;
    summary: string;
    model: string;
    workspace?: WorkspaceMode;
  }>;
};

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function normalizeTask(input: {
  agent: AgentName;
  task: string;
  summary?: string;
  model?: string;
  workspace?: WorkspaceMode;
}): DelegatedTask {
  if (typeof input.model !== "string" || input.model.trim() === "") {
    throw new Error(
      `action=start requires an explicit model for ${input.agent}; pass the desired model, including the parent session model when appropriate.`,
    );
  }
  const model = input.model;
  const workspace = resolveAgentWorkspace(
    input.agent,
    input.workspace,
  ) as WorkspaceMode;
  // Summary normalization enforces the one-line title and the shared 160
  // char budget (schema maxLength applies first at the agent loop; this
  // backstops direct callers). See summary.mjs.
  const summary = normalizeSummary(input.summary, input.agent);
  return { ...input, model, summary, workspace };
}

function resolveModel(
  task: DelegatedTask,
  agentModel: string | undefined,
  parentModel: { provider: string; id: string } | undefined,
): string {
  const inherited = parentModel
    ? `${parentModel.provider}/${parentModel.id}`
    : undefined;
  const model = resolveRoutedModel({
    taskModel: task.model,
    agent: task.agent,
    agentDir: getAgentDir(),
    legacyModel: agentModel,
    parentModel: inherited,
  });
  if (!model) {
    throw new Error(
      `No model is available for ${task.agent}. Specify the model parameter.`,
    );
  }
  return model;
}

function jobSummary(job: SubagentJobRecord): string {
  if (job.summary) return job.summary;
  // Fallback for job records written before summaries existed.
  return fallbackSummary(job.task);
}

function snapshotLine(snapshot: JobSnapshot): string {
  const job = snapshot.job;
  const approval = snapshot.pendingApprovals?.[0];
  const activity = approval
    ? ` approval:${approval.id.slice(0, 12)} ${approval.ruleName}`
    : snapshot.live.currentTool
      ? ` tool:${snapshot.live.currentTool.name} ${snapshot.live.currentTool.summary} (${formatDuration(snapshot.toolElapsedMs ?? 0)})`
      : ` activity:${snapshot.live.activity}`;
  return `${job.id.slice(0, 12)} ${job.agent} [${job.mode}] ${job.state} ${formatDuration(snapshot.elapsedMs)} "${jobSummary(job)}"${activity}`;
}

function snapshotText(
  snapshot: JobSnapshot,
  options: { includeOutputs?: boolean } = {},
): string {
  const { job, live } = snapshot;
  const lines = [
    `job: ${job.id}`,
    `agent: ${job.agent}`,
    `summary: ${jobSummary(job)}`,
    `mode: ${job.mode}`,
    `state: ${job.state}`,
    `elapsed: ${formatDuration(snapshot.elapsedMs)}`,
    `model: ${job.model}`,
    `activity: ${live.activity}`,
    `last event: ${live.lastEventAt}`,
    `turns: ${live.usage.turns}`,
    `tokens: in ${formatTokens(live.usage.input)}, out ${formatTokens(live.usage.output)}, cache ${formatTokens(live.usage.cacheRead)}`,
  ];
  for (const request of snapshot.pendingApprovals ?? []) {
    lines.push(
      `approval required: ${request.id}`,
      `approval rule: ${request.ruleName}`,
      `approval reason: ${request.reason}`,
      `approval tool: ${request.toolName}`,
    );
    if (request.command) lines.push(`approval command: ${request.command}`);
    if (request.path) lines.push(`approval path: ${request.path}`);
  }
  if (snapshot.supervisorIdentity === "unverified") {
    lines.push(
      "supervisor identity: unverified (signals and cleanup disabled)",
    );
  }
  if (snapshot.childIdentity === "unverified") {
    lines.push("child identity: unverified (signals and cleanup disabled)");
  }
  if (live.currentTool) {
    lines.push(
      `current tool: ${live.currentTool.name}`,
      `tool detail: ${live.currentTool.summary}`,
      `tool elapsed: ${formatDuration(snapshot.toolElapsedMs ?? 0)}`,
      `tool arguments: ${JSON.stringify(live.currentTool.arguments)}`,
    );
    if (live.currentTool.partialResult !== undefined) {
      lines.push(
        `partial tool result: ${JSON.stringify(live.currentTool.partialResult)}`,
      );
    } else {
      lines.push("partial tool result: unavailable from this tool");
    }
  }
  if (options.includeOutputs !== false && live.partialAssistantOutput) {
    lines.push(`partial assistant output:\n${live.partialAssistantOutput}`);
  }
  if (options.includeOutputs !== false && live.latestCompletedOutput) {
    lines.push(`latest completed output:\n${live.latestCompletedOutput}`);
  }
  if (job.sessionPath) lines.push(`session: ${job.sessionPath}`);
  else lines.push(`session directory: ${job.sessionDir}`);
  if (job.workspace) lines.push(`workspace: ${job.workspace.path}`);
  if (job.errorMessage || live.errorMessage) {
    lines.push(`error: ${job.errorMessage || live.errorMessage}`);
  }
  return lines.join("\n");
}

function details(
  action: SubagentDetails["action"],
  jobs: JobSnapshot[],
  extras: Omit<Partial<SubagentDetails>, "action" | "jobs"> = {},
): SubagentDetails {
  return { action, jobs, ...extras };
}

function observationDetails(
  observation: JobObservation,
): NonNullable<SubagentDetails["observation"]> {
  return {
    reason: observation.reason,
    stalledJobIds: observation.stalledJobIds,
    pendingApprovalJobIds: observation.pendingApprovalJobIds,
    waitSeconds: observation.waitSeconds,
    stallSeconds: observation.stallSeconds,
  };
}

function requireJobId(params: SubagentParamsType): string {
  if (!params.jobId) throw new Error(`action=${params.action} requires jobId`);
  return params.jobId;
}

function requireJobIds(params: SubagentParamsType): string[] {
  return normalizeWaitJobIds(params.jobIds);
}

function selectPendingApproval(
  snapshot: JobSnapshot,
  reference?: string,
): ApprovalRequest {
  const pending = snapshot.pendingApprovals ?? [];
  if (pending.length === 0) {
    throw new Error(`Job ${snapshot.job.id} has no pending approval request`);
  }
  if (!reference) {
    if (pending.length === 1) return pending[0];
    throw new Error(
      `Job ${snapshot.job.id} has multiple pending approvals; specify requestId: ${pending.map((request) => request.id).join(", ")}`,
    );
  }
  const matches = pending.filter((request) => request.id.startsWith(reference));
  if (matches.length === 0) {
    throw new Error(
      `Unknown pending approval for job ${snapshot.job.id}: ${reference}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous approval request prefix: ${reference}`);
  }
  return matches[0];
}

function approvalConfirmationText(
  snapshot: JobSnapshot,
  request: ApprovalRequest,
): string {
  return [
    `Job: ${snapshot.job.id}`,
    `Agent: ${snapshot.job.agent}`,
    `Model: ${snapshot.job.model}`,
    `Project: ${snapshot.job.sourceRoot}`,
    "",
    `Rule: ${request.ruleName}`,
    `Tool: ${request.toolName}`,
    ...(request.command ? [`Command: ${request.command}`] : []),
    ...(request.path ? [`Path: ${request.path}`] : []),
    `Reason: ${request.reason}`,
    ...(request.explanation
      ? ["", `Worker explanation: ${request.explanation}`]
      : []),
    "",
    "Approval applies once to this exact tool call.",
  ].join("\n");
}

async function authorizePendingJob(
  reference: string,
  requestReference: string | undefined,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<{
  snapshot: JobSnapshot;
  request: ApprovalRequest;
  approved: boolean;
}> {
  const initial = await getJobSnapshot(reference);
  const request = selectPendingApproval(initial, requestReference);
  const approved = await confirm(
    "Authorize implementer action?",
    approvalConfirmationText(initial, request),
  );
  await resolveJobApproval(
    initial.job.id,
    request.id,
    approved ? "allow" : "deny",
  );
  writeLog({
    timestamp: new Date().toISOString(),
    module: "gate",
    action: approved ? "allowed" : "blocked",
    tool: request.toolName,
    command: request.command,
    path: request.path,
    reason: `subagent ${initial.job.id} ${request.ruleName}: ${request.reason}`,
    userChoice: approved ? "parent-approved" : "parent-denied",
  });
  return {
    snapshot: await getJobSnapshot(initial.job.id),
    request,
    approved,
  };
}

async function workspaceCleanupBlocker(
  record: WorkspaceRecord,
): Promise<string | undefined> {
  const activeJob = await findActiveJobUsingWorkspace(record.id);
  if (activeJob) {
    return `Workspace ${record.id} is still used by job ${activeJob.job.id} (${activeJob.job.state}).`;
  }
  return undefined;
}

async function confirmWorktree(
  task: DelegatedTask,
  cwd: string,
  hasUI: boolean,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<void> {
  if (task.workspace !== "worktree") return;
  const git = await inspectGitState(cwd);
  if (!git) throw new Error("Worktree mode requires a Git repository");
  if (!git.dirty) return;
  if (!hasUI) {
    throw new Error(
      "The source repository is dirty. Worktree mode uses HEAD and requires interactive confirmation.",
    );
  }
  const preview = git.status.split("\n").slice(0, 12).join("\n");
  const approved = await confirm(
    "Create worktree from HEAD?",
    `Uncommitted changes will not be included:\n\n${preview}`,
  );
  if (!approved) throw new Error("Worktree experiment cancelled");
}

async function confirmProjectExecution(
  task: DelegatedTask,
  cwd: string,
  model: string,
  hasUI: boolean,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<void> {
  if (task.workspace !== "project") return;
  const git = await inspectGitState(cwd);
  if (!git) throw new Error("Project mode requires a Git repository");
  if (!hasUI) {
    throw new Error(
      "Project mode writes directly to the current repository and requires interactive confirmation",
    );
  }
  const status = git.status
    ? git.status.split("\n").slice(0, 12).join("\n")
    : "(clean working tree)";
  const approved = await confirm(
    "Start project-writing subagent?",
    [
      `Agent: ${task.agent}`,
      `Model: ${model}`,
      `Repository: ${git.repoRoot}`,
      "",
      "The subagent will modify this working tree directly and must preserve all existing changes.",
      "",
      "Current status:",
      status,
    ].join("\n"),
  );
  if (!approved) throw new Error("Project-writing subagent cancelled");
}

export default function multiAgent(pi: ExtensionAPI) {
  let parentMode: "strict" | "direct" = "strict";
  const explorationBudget: { marker?: string; used: number } = { used: 0 };

  // A cleaned or removed job must not lock the parent, while a failed lookup
  // (which may be unrelated) must not clear a genuinely active job: the policy
  // module refreshes retained jobs and keeps the last known state on errors.
  const resolveParentGuardJob = async (
    reference: string,
  ): Promise<JobSnapshot | undefined> => {
    try {
      return await getJobSnapshot(reference);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unknown subagent job:")
      ) {
        return undefined;
      }
      throw error;
    }
  };

  pi.on("tool_call", (event, ctx) =>
    evaluateParentToolCall(event, {
      branch: ctx.sessionManager.getBranch(),
      cwd: ctx.cwd,
      mode: parentMode,
      resolveJob: resolveParentGuardJob,
      explorationBudget,
    }),
  );

  pi.registerCommand("agent-mode", {
    description: "Show or set the session-local parent delegation guard mode",
    async handler(args, ctx) {
      const requested = args.trim();
      if (!requested) {
        ctx.ui.notify(
          `Parent agent mode: ${parentMode}. Use /agent-mode strict or /agent-mode direct.`,
          "info",
        );
        return;
      }
      if (requested !== "strict" && requested !== "direct") {
        ctx.ui.notify(
          "Usage: /agent-mode <strict|direct>",
          "warning",
        );
        return;
      }
      parentMode = requested;
      ctx.ui.notify(
        `Parent agent mode set to ${parentMode}.`,
        parentMode === "direct" ? "warning" : "info",
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Manage persistent background scout, feasibility, reviewer, or implementer jobs.",
      "Use action=start to launch and receive a job ID immediately.",
      "Use status, wait, wait_many, result, abort, list, authorize, or stats to inspect and control retained jobs.",
      "wait uses role-aware observation windows, returns early for completion, authorization, inactivity, or deadline, and never terminates a child.",
      "Default list shows every active job and the five newest finished jobs; history and filters use pages of 20 (limit and offset supported).",
    ].join(" "),
    promptSnippet:
      "Start and control persistent background subagents with status, wait, wait_many, result, stats, abort, list, and parent-mediated authorization",
    promptGuidelines: [
      "Use subagent action=start for non-trivial repository work: prefer a subagent for broad exploration, independent verification, and approved implementation. Keep simple commands, single-file lookups, and genuinely narrow tasks direct.",
      "Do not duplicate broad exploration already delegated to a subagent; use action=wait, action=wait_many, or action=result to consume its evidence, and keep parent read/bash for narrow checks, adjudication, and final verification.",
      "On action=start always provide summary: a one-line title (<= 160 chars) for the delegated work; the user sees it in the UI to understand what the subagent is for.",
      "Use the implementer agent only for an implementation plan the user approved; include the complete plan, constraints, acceptance criteria, and verification commands in its task.",
      "After starting a reviewer or implementer, do not edit project files in the same user turn. Adjudicate reviewer findings and send only accepted Finding IDs to a remediation implementer; /agent-mode direct is an intentional user override.",
      "When wait or status reports a pending approval, use subagent action=authorize for that job; the tool itself asks the user and records a one-shot decision.",
      "After subagent action=start, retain the returned job ID. wait and stall thresholds use role floors (scout 600s, reviewer/feasibility 1200s, implementer 1800s; mixed jobs use the longest). waitSeconds is raised to the floor even when 0 is passed, so prefer one wait over repeated status calls; stallSeconds: 0 disables early stalled observation return.",
      "Use action=wait_many with one or two retained job IDs when either job needing authorization or becoming inactive should wake the parent. Use action=result with view=full only when the compact output summary is insufficient.",
      "Use action=stats to inspect unique child usage from this active parent branch. It is separate from footer accounting.",
      "Use subagent action=abort only after inspecting the job and deciding it should be stopped; cancelling a wait does not stop the child.",
      "For action=start, always provide an explicit model in subagent.model or every subagent.tasks[].model; it may be the same as the parent session model.",
      "When the user specifies a model for delegated work, pass that exact model in subagent.model or subagent.tasks[].model.",
      "Do not ask a subagent to invoke another agent.",
    ],
    parameters: SubagentParams,
    prepareArguments(args) {
      const input =
        args && typeof args === "object"
          ? (args as SubagentParamsType)
          : ({} as SubagentParamsType);
      if (!input.action && (input.agent || input.task || input.tasks?.length)) {
        return { ...input, action: "start" as const };
      }
      return input;
    },

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as SubagentParamsType;
      const action = params.action ?? "start";

      if (action === "start") {
        const hasSingle = Boolean(params.agent && params.task);
        const hasParallel = Boolean(params.tasks && params.tasks.length > 0);
        if (Number(hasSingle) + Number(hasParallel) !== 1) {
          throw new Error(
            "action=start requires exactly one mode: agent + task, or a tasks array",
          );
        }
        const tasks = hasSingle
          ? [
              normalizeTask({
                agent: params.agent!,
                task: params.task!,
                summary: params.summary,
                model: params.model,
                workspace: params.workspace,
              }),
            ]
          : params.tasks!.map((item) => normalizeTask(item));
        if (tasks.length > MAX_PARALLEL) {
          throw new Error(
            `Parallel mode supports at most ${MAX_PARALLEL} tasks`,
          );
        }
        if (
          hasParallel &&
          tasks.some((task) => requiresSingleDispatch(task.agent))
        ) {
          throw new Error(
            "Feasibility and implementer roles require single agent + task dispatch",
          );
        }
        for (const task of tasks) {
          if (task.agent === "implementer") {
            assertImplementerTaskSafe(task.task);
          }
        }
        if (
          tasks.some((task) => task.agent === "feasibility") &&
          (await hasActiveFeasibilityJob())
        ) {
          throw new Error("A feasibility experiment is already running");
        }

        const launchItems: Array<{
          task: DelegatedTask;
          config: AgentConfig;
          model: string;
        }> = [];
        for (const task of tasks) {
          const config = findAgent(task.agent);
          if (!config) {
            throw new Error(
              `Agent definition not found for ${task.agent} in ~/.pi/agent/agents`,
            );
          }
          const model = resolveModel(task, config.model, ctx.model);
          await confirmWorktree(task, ctx.cwd, ctx.hasUI, (title, message) =>
            ctx.ui.confirm(title, message),
          );
          await confirmProjectExecution(
            task,
            ctx.cwd,
            model,
            ctx.hasUI,
            (title, message) => ctx.ui.confirm(title, message),
          );
          launchItems.push({ task, config, model });
        }

        const jobs: JobSnapshot[] = [];
        const failures: string[] = [];
        for (const item of launchItems) {
          const jobId = createJobId();
          let workspace: PreparedWorkspace | undefined;
          let feasibilityLease: LeaseHandle | undefined;
          let implementerLeases: LeaseHandle[] | undefined;
          let startInvoked = false;
          try {
            if (item.task.agent === "feasibility") {
              feasibilityLease = await acquireFeasibilityLease(jobId, signal);
            }
            workspace = await prepareWorkspace(
              item.task.workspace,
              ctx.cwd,
              item.task.task,
              signal,
              jobId,
            );
            if (item.task.agent === "implementer") {
              if (!workspace.writableRoot) {
                throw new Error(
                  "Implementer project workspace has no writable root",
                );
              }
              implementerLeases = await acquireImplementerLeases(
                workspace.writableRoot,
                jobId,
                signal,
              );
            }
            startInvoked = true;
            const snapshot = await startJob({
              id: jobId,
              ...item,
              workspace,
              feasibilityLease,
              implementerLeases,
              guardPath: GUARD_PATH,
            });
            jobs.push(snapshot);
            if (snapshot.job.state === "failed") {
              failures.push(
                `${item.task.agent} (${jobId}): ${snapshot.job.errorMessage ?? "startup failed"}`,
              );
            }
            onUpdate?.({
              content: [
                { type: "text", text: `Created ${snapshotLine(snapshot)}` },
              ],
              details: details("start", [...jobs], {
                failures: [...failures],
              }),
            });
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            failures.push(`${item.task.agent} (${jobId}): ${reason}`);
            if (!startInvoked) {
              for (const release of [
                () => releasePreparedWorkspaceLease(workspace),
                () => releaseUnstartedLeases(implementerLeases),
                () => releaseUnstartedLease(feasibilityLease),
              ]) {
                try {
                  await release();
                } catch (releaseError) {
                  failures.push(
                    `${item.task.agent}: lease release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
                  );
                }
              }
            }
            if (workspace?.record) {
              const owner = await findJobUsingWorkspace(workspace.record.id);
              if (!owner) {
                try {
                  await cleanupWorkspace(workspace.record.id, {
                    canRecoverLease: async () => !startInvoked,
                  });
                } catch (cleanupError) {
                  const cleanupReason =
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError);
                  failures.push(
                    `${item.task.agent}: failed to clean unowned workspace: ${cleanupReason}`,
                  );
                }
              }
            }
          }
        }
        if (jobs.length === 0) {
          throw new Error(
            `No subagent jobs were started: ${failures.join("; ")}`,
          );
        }
        const text = [
          "Created persistent subagent job(s):",
          ...jobs.map((snapshot) => snapshotLine(snapshot)),
          ...(failures.length
            ? [
                "",
                "Startup failures:",
                ...failures.map((failure) => `- ${failure}`),
              ]
            : []),
          "",
          `Observe with action=wait (role defaults: scout 600s, reviewer/feasibility 1200s, implementer 1800s), status, or result.`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: details("start", jobs, { failures }),
        };
      }

      if (action === "list") {
        const jobs = await listJobSnapshots({
          history: params.history,
          state: params.state,
          agent: params.agent,
          session: params.session,
          limit: params.limit,
          offset: params.offset,
        });
        const text = jobs.length
          ? [
              jobs.map(snapshotLine).join("\n"),
              ...(params.history || params.state || params.agent || params.session
                ? [`Page offset ${params.offset ?? 0}; next page: offset=${(params.offset ?? 0) + jobs.length}`]
                : []),
            ].join("\n")
          : "No retained subagent jobs.";
        return {
          content: [{ type: "text", text }],
          details: details("list", jobs),
        };
      }

      if (action === "stats") {
        const branch = ctx.sessionManager.getBranch();
        const history = collectSubagentHistory(branch);
        const snapshots: JobSnapshot[] = [];
        for (const reference of history.jobIds) {
          try {
            snapshots.push(await getJobSnapshot(reference));
          } catch {
            // Retained jobs may have been explicitly cleaned after this branch observed them.
          }
        }
        const stats = {
          parent: aggregateParentUsage(branch),
          ...aggregateSubagentStats({
            snapshots,
            actionEvents: history.actionEvents,
            referencedJobIds: history.jobIds,
          }),
        };
        return {
          content: [{ type: "text", text: formatStatsSummary(stats) }],
          details: details("stats", snapshots, { stats }),
        };
      }

      if (action === "wait_many") {
        const observation = await observeJobs(requireJobIds(params), {
          waitSeconds: params.waitSeconds,
          stallSeconds: params.stallSeconds,
          signal,
          onUpdate: (snapshots) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting; ${formatCompactSnapshots(snapshots)}`,
                },
              ],
              details: details("wait_many", snapshots),
            });
          },
        });
        return {
          content: [
            {
              type: "text",
              text: formatCompactSnapshots(observation.snapshots, observation),
            },
          ],
          details: details("wait_many", observation.snapshots, {
            observation: observationDetails(observation),
          }),
        };
      }

      const jobId = requireJobId(params);
      if (action === "authorize") {
        if (!ctx.hasUI) {
          throw new Error(
            "action=authorize requires an interactive parent session",
          );
        }
        const outcome = await authorizePendingJob(
          jobId,
          params.requestId,
          (title, message) => ctx.ui.confirm(title, message),
        );
        const decision = outcome.approved ? "allowed" : "denied";
        return {
          content: [
            {
              type: "text",
              text: `Authorization ${decision} for request ${outcome.request.id}. The subagent will continue.\n\n${snapshotText(outcome.snapshot)}`,
            },
          ],
          details: details("authorize", [outcome.snapshot]),
        };
      }

      if (action === "status") {
        const snapshot = await getJobSnapshot(jobId);
        return {
          content: [{ type: "text", text: formatCompactSnapshots([snapshot]) }],
          details: details("status", [snapshot]),
        };
      }

      if (action === "wait") {
        const observation = await observeJobs([jobId], {
          waitSeconds: params.waitSeconds,
          stallSeconds: params.stallSeconds,
          signal,
          onUpdate: (snapshots) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting; ${formatCompactSnapshots(snapshots)}`,
                },
              ],
              details: details("wait", snapshots),
            });
          },
        });
        return {
          content: [
            {
              type: "text",
              text: formatCompactSnapshots(observation.snapshots, observation),
            },
          ],
          details: details("wait", observation.snapshots, {
            observation: observationDetails(observation),
          }),
        };
      }

      if (action === "result") {
        const result = await getJobResult(
          jobId,
          params.cursor ?? 0,
          params.limit ?? 100,
        );
        const output =
          result.finalOutput ||
          result.live.partialAssistantOutput ||
          result.live.latestCompletedOutput ||
          "(no assistant output yet)";
        const boundedOutput = truncateOutput(output);
        const view = params.view ?? "summary";
        const text = formatResultContent(result, boundedOutput, view);
        const {
          activities: _activities,
          nextCursor: _nextCursor,
          finalOutput: _finalOutput,
          messages: _messages,
          ...resultSnapshot
        } = result;
        const {
          partialAssistantOutput: _partialAssistantOutput,
          latestCompletedOutput: _latestCompletedOutput,
          latestToolResult: _latestToolResult,
          currentTool,
          ...boundedLive
        } = resultSnapshot.live;
        const boundedCurrentTool = currentTool
          ? {
              ...currentTool,
              summary: truncateUtf8(currentTool.summary, 2048),
              arguments: undefined,
              partialResult: undefined,
            }
          : undefined;
        const detailSnapshot: JobSnapshot = {
          ...resultSnapshot,
          job: {
            ...resultSnapshot.job,
            task: truncateUtf8(resultSnapshot.job.task, 16 * 1024),
            errorMessage: resultSnapshot.job.errorMessage
              ? truncateUtf8(resultSnapshot.job.errorMessage, 8 * 1024)
              : undefined,
            workspace: resultSnapshot.job.workspace
              ? {
                  ...resultSnapshot.job.workspace,
                  task: truncateUtf8(
                    resultSnapshot.job.workspace.task,
                    4 * 1024,
                  ),
                }
              : undefined,
          },
          live: {
            ...boundedLive,
            activity: truncateUtf8(boundedLive.activity, 2048),
            errorMessage: boundedLive.errorMessage
              ? truncateUtf8(boundedLive.errorMessage, 8 * 1024)
              : undefined,
            currentTool: boundedCurrentTool,
          },
        };
        const detailActivities = result.activities
          .slice(0, 200)
          .map(({ data: _data, ...event }) => ({
            ...event,
            summary: event.summary
              ? truncateUtf8(event.summary, 512)
              : undefined,
          }));
        const resultDetails = details("result", [detailSnapshot], {
          activities: detailActivities,
          nextCursor: result.nextCursor,
          resultOutput: boundedOutput,
        });
        while (
          resultDetails.activities?.length &&
          Buffer.byteLength(JSON.stringify(resultDetails), "utf8") >
            RESULT_DETAILS_CAP
        ) {
          resultDetails.activities.pop();
        }
        if (
          Buffer.byteLength(JSON.stringify(resultDetails), "utf8") >
          RESULT_DETAILS_CAP
        ) {
          detailSnapshot.job.task = truncateUtf8(detailSnapshot.job.task, 1024);
          detailSnapshot.job.workspace = undefined;
          detailSnapshot.live.currentTool = undefined;
          detailSnapshot.live.errorMessage = detailSnapshot.live.errorMessage
            ? truncateUtf8(detailSnapshot.live.errorMessage, 1024)
            : undefined;
        }
        for (const outputCap of [64 * 1024, 16 * 1024, 4 * 1024]) {
          if (
            Buffer.byteLength(JSON.stringify(resultDetails), "utf8") <=
            RESULT_DETAILS_CAP
          ) {
            break;
          }
          resultDetails.resultOutput = truncateUtf8(
            resultDetails.resultOutput ?? "",
            outputCap,
            { tailBytes: Math.min(1024, Math.floor(outputCap / 4)), reportOmitted: true },
          );
        }
        return {
          content: [{ type: "text", text }],
          details: resultDetails,
        };
      }

      if (action === "abort") {
        const snapshot = await abortJob(jobId);
        return {
          content: [
            {
              type: "text",
              text: `Abort requested. The session and logs are retained.\n\n${snapshotText(snapshot)}`,
            },
          ],
          details: details("abort", [snapshot]),
        };
      }

      throw new Error(`Unsupported subagent action: ${action}`);
    },

    renderCall(args, theme) {
      const action =
        args.action ?? (args.agent || args.tasks?.length ? "start" : "unknown");
      let text = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", action)}`;
      if (args.jobId) text += ` ${theme.fg("muted", args.jobId)}`;
      if (args.jobIds?.length) {
        text += ` ${theme.fg("muted", args.jobIds.join(","))}`;
      }
      if (action === "start" && args.agent) {
        const workspace =
          args.workspace ??
          (args.agent === "implementer" ? "project" : "research");
        text += ` ${theme.fg("accent", args.agent)} [${workspace}]`;
        if (args.summary) text += ` ${theme.fg("dim", `"${args.summary}"`)}`;
      }
      if (action === "start" && args.tasks?.length) {
        text += ` parallel (${args.tasks.length})`;
        for (const item of args.tasks) {
          text += `\n  ${theme.fg("accent", item.agent ?? "?")}${item.summary ? ` ${theme.fg("dim", `"${item.summary}"`)}` : ""}`;
        }
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const info = result.details as SubagentDetails | undefined;
      if (!info?.jobs.length) {
        const content = result.content[0];
        return new Text(
          content?.type === "text" ? content.text : "(no output)",
          0,
          0,
        );
      }
      if (!expanded) {
        return new Text(info.jobs.map(snapshotLine).join("\n"), 0, 0);
      }
      const container = new Container();
      for (const [index, snapshot] of info.jobs.entries()) {
        if (index > 0) container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.bold(
              `${snapshot.job.id.slice(0, 12)} ${snapshot.job.agent}`,
            ) +
              theme.fg("dim", ` "${jobSummary(snapshot.job)}"`) +
              theme.fg(
                "dim",
                ` ${snapshot.job.state} ${formatDuration(snapshot.elapsedMs)}`,
              ),
            0,
            0,
          ),
        );
        container.addChild(new Text(snapshotText(snapshot), 0, 0));
      }
      const content = result.content[0];
      if (info.action === "result") {
        const output = info.resultOutput ??
          (content?.type === "text" ? content.text : "(no assistant output yet)");
        const label =
          info.jobs[0]?.job.state === "completed"
            ? "Final output:"
            : "Current output:";
        container.addChild(new Spacer(1));
        container.addChild(
          new Markdown(`${label}\n${output}`, 0, 0, getMarkdownTheme()),
        );
      } else if (content?.type === "text" && info.action === "stats") {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(content.text, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
  });

  pi.registerCommand("agent-jobs", {
    description:
      "List, inspect, authorize, abort, or clean retained subagent jobs",
    async handler(args, ctx) {
      const [action, id, requestId] = args.trim().split(/\s+/, 3);
      if (!action || action === "list") {
        const options: {
          history?: boolean;
          state?: JobState;
          agent?: AgentName;
          session?: string;
          limit?: number;
          offset?: number;
        } = {};
        const tokens = action ? args.trim().split(/\s+/).slice(1) : [];
        for (const token of tokens) {
          if (token === "history") {
            options.history = true;
            continue;
          }
          const [key, value, extra] = token.split("=");
          if (!value || extra !== undefined) {
            ctx.ui.notify(`Invalid list option: ${token}`, "warning");
            return;
          }
          if (key === "state" && ["queued", "running", "aborting", "completed", "failed", "aborted", "orphaned"].includes(value)) {
            options.state = value as JobState;
          } else if (key === "agent" && AGENT_NAMES.some((name) => name === value)) {
            options.agent = value as AgentName;
          } else if (key === "session") {
            options.session = value;
          } else if ((key === "limit" || key === "offset") && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && (key === "offset" || Number(value) > 0) && (key === "offset" || Number(value) <= 500)) {
            options[key] = Number(value);
          } else {
            ctx.ui.notify(`Invalid list option: ${token}`, "warning");
            return;
          }
        }
        const jobs = await listJobSnapshots(options);
        ctx.ui.notify(
          jobs.length
            ? [
                jobs.map(snapshotLine).join("\n"),
                ...(options.history || options.state || options.agent || options.session
                  ? [`Page offset ${options.offset ?? 0}; next page: offset=${(options.offset ?? 0) + jobs.length}`]
                  : []),
              ].join("\n")
            : "No retained subagent jobs.",
          "info",
        );
        return;
      }
      if (!id) {
        ctx.ui.notify(
          "Usage: /agent-jobs <status|authorize|abort|clean> <job-id> [request-id]",
          "warning",
        );
        return;
      }
      if (action === "status") {
        ctx.ui.notify(snapshotText(await getJobSnapshot(id)), "info");
        return;
      }
      if (action === "authorize") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Authorization requires an interactive session.",
            "error",
          );
          return;
        }
        const outcome = await authorizePendingJob(
          id,
          requestId,
          (title, message) => ctx.ui.confirm(title, message),
        );
        ctx.ui.notify(
          `${outcome.approved ? "Allowed" : "Denied"} request ${outcome.request.id}.`,
          outcome.approved ? "info" : "warning",
        );
        return;
      }
      if (action === "abort") {
        const approved = await ctx.ui.confirm(
          "Abort subagent job?",
          `Job ${id}\n\nThe child session and logs will be retained.`,
        );
        if (!approved) return;
        const snapshot = await abortJob(id);
        ctx.ui.notify(snapshotLine(snapshot), "info");
        return;
      }
      if (action === "clean") {
        const snapshot = await getJobSnapshot(id);
        const approved = await ctx.ui.confirm(
          "Remove retained subagent job?",
          `${snapshot.job.id}\n${snapshot.job.jobDir}\n\nThe child session and logs will be deleted.`,
        );
        if (!approved) return;
        const cleaned = await cleanupJob(id);
        ctx.ui.notify(`Removed job ${cleaned.id}.`, "info");
        return;
      }
      ctx.ui.notify(`Unknown action: ${action}`, "warning");
    },
  });

  pi.registerCommand("agent-workspaces", {
    description:
      "List, prune, or clean retained subagent experiment workspaces",
    async handler(args, ctx) {
      const [action, id] = args.trim().split(/\s+/, 2);
      if (action === "prune") {
        const count = await pruneMissingWorkspaces({
          canRecoverLease: async (record) =>
            (await workspaceCleanupBlocker(record)) === undefined,
        });
        ctx.ui.notify(`Pruned ${count} missing workspace record(s).`, "info");
        return;
      }
      if (action === "clean") {
        if (!id) {
          ctx.ui.notify("Usage: /agent-workspaces clean <id>", "warning");
          return;
        }
        const records = await listWorkspaces();
        const record = records.find((item) => item.id === id);
        if (!record) {
          ctx.ui.notify(`Unknown workspace: ${id}`, "error");
          return;
        }
        const blocker = await workspaceCleanupBlocker(record);
        if (blocker) {
          ctx.ui.notify(blocker, "error");
          return;
        }
        const approved = await ctx.ui.confirm(
          "Remove experiment workspace?",
          `${record.mode} ${record.id}\n${record.path}\n\nUncommitted experiment files will be deleted.`,
        );
        if (!approved) return;
        const recheckedBlocker = await workspaceCleanupBlocker(record);
        if (recheckedBlocker) {
          ctx.ui.notify(`${recheckedBlocker} Cleanup cancelled.`, "error");
          return;
        }
        await cleanupWorkspace(id, {
          canRecoverLease: async () =>
            (await workspaceCleanupBlocker(record)) === undefined,
        });
        ctx.ui.notify(`Removed workspace ${id}.`, "info");
        return;
      }
      const records = await listWorkspaces();
      if (records.length === 0) {
        ctx.ui.notify("No retained experiment workspaces.", "info");
        return;
      }
      const lines = records.map(
        (record) =>
          `${record.id} [${record.mode}] ${record.createdAt}\n  ${record.path}\n  ${record.task.slice(0, 100)}`,
      );
      ctx.ui.notify(
        `${lines.join("\n\n")}\n\nClean with: /agent-workspaces clean <id>`,
        "info",
      );
    },
  });
}
