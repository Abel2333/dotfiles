import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findAgent } from "./agents";
import {
  abortJob,
  acquireFeasibilityLease,
  cleanupJob,
  createJobId,
  findActiveJobUsingWorkspace,
  findJobUsingWorkspace,
  getJobResult,
  getJobSnapshot,
  hasActiveFeasibilityJob,
  listJobSnapshots,
  releaseUnstartedLease,
  startJob,
  waitForJob,
} from "./jobs";
import { truncateUtf8 } from "./limits.mjs";
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
  JobSnapshot,
  LeaseHandle,
  PreparedWorkspace,
  SubagentDetails,
  SubagentJobRecord,
  WorkspaceMode,
  WorkspaceRecord,
} from "./types";
import { TERMINAL_JOB_STATES } from "./types";
import {
  cleanupWorkspace,
  inspectGitState,
  listWorkspaces,
  prepareWorkspace,
  pruneMissingWorkspaces,
  releasePreparedWorkspaceLease,
} from "./workspace";

const AGENT_NAMES = ["scout", "feasibility", "reviewer"] as const;
const WORKSPACE_MODES = ["research", "scratch", "worktree"] as const;
const ACTIONS = ["start", "status", "wait", "result", "abort", "list"] as const;
const MAX_PARALLEL = 2;
const DEFAULT_WAIT_SECONDS = 300;
const SUMMARY_SCHEMA = {
  maxLength: SUMMARY_MAX_CHARS,
  description:
    "One-line title (<= 160 chars) for the delegated task, shown to the user in the UI.",
};
const ACTIVITY_TEXT_CAP = 32 * 1024;
const RESULT_DETAILS_CAP = 256 * 1024;
const GUARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "child-guard.ts",
);

const AgentSchema = StringEnum(AGENT_NAMES);
const WorkspaceSchema = StringEnum(WORKSPACE_MODES, {
  description:
    "research is read-only; scratch writes in /tmp; worktree writes in a detached Git worktree",
});
const ActionSchema = StringEnum(ACTIONS, {
  description:
    "start, status, wait, result, abort, or list. Legacy start calls may omit action.",
});

const ParallelTaskSchema = Type.Object({
  agent: AgentSchema,
  task: Type.String({ description: "Specific task delegated to the agent" }),
  summary: Type.String(SUMMARY_SCHEMA),
  model: Type.Optional(
    Type.String({
      description:
        "Model override. If the user named a model, pass that model exactly.",
    }),
  ),
  workspace: Type.Optional(WorkspaceSchema),
});

const SubagentParams = Type.Object({
  action: Type.Optional(ActionSchema),
  jobId: Type.Optional(
    Type.String({ description: "Full job ID or a unique job ID prefix" }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Maximum observation wait. Defaults to 300 seconds and never terminates the child.",
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
      description: "Result or list item limit",
    }),
  ),
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
        "Model override for a start action. If the user named a model, pass that model exactly.",
    }),
  ),
  workspace: Type.Optional(WorkspaceSchema),
  tasks: Type.Optional(
    Type.Array(ParallelTaskSchema, {
      maxItems: MAX_PARALLEL,
      description:
        "Up to two parallel read-only scout or reviewer tasks. Feasibility cannot run in parallel.",
    }),
  ),
});

type SubagentParamsType = {
  action?: (typeof ACTIONS)[number];
  jobId?: string;
  waitSeconds?: number;
  cursor?: number;
  limit?: number;
  agent?: AgentName;
  task?: string;
  summary?: string;
  model?: string;
  workspace?: WorkspaceMode;
  tasks?: Array<{
    agent: AgentName;
    task: string;
    summary: string;
    model?: string;
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
  const workspace = input.workspace ?? "research";
  if (input.agent !== "feasibility" && workspace !== "research") {
    throw new Error(`${input.agent} supports research mode only`);
  }
  // Summary normalization enforces the one-line title and the shared 160
  // char budget (schema maxLength applies first at the agent loop; this
  // backstops direct callers). See summary.mjs.
  const summary = normalizeSummary(input.summary, input.agent);
  return { ...input, summary, workspace };
}

function resolveModel(
  task: DelegatedTask,
  agentModel: string | undefined,
  parentModel: { provider: string; id: string } | undefined,
): string {
  const inherited = parentModel
    ? `${parentModel.provider}/${parentModel.id}`
    : undefined;
  const model = task.model || agentModel || inherited;
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
  const tool = snapshot.live.currentTool
    ? ` tool:${snapshot.live.currentTool.name} ${snapshot.live.currentTool.summary} (${formatDuration(snapshot.toolElapsedMs ?? 0)})`
    : ` activity:${snapshot.live.activity}`;
  return `${job.id.slice(0, 12)} ${job.agent} [${job.mode}] ${job.state} ${formatDuration(snapshot.elapsedMs)} "${jobSummary(job)}"${tool}`;
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

function boundedActivityText(lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [
    truncateUtf8(lines.join("\n"), ACTIVITY_TEXT_CAP, {
      tailBytes: 8 * 1024,
      reportOmitted: true,
    }),
  ];
}

function details(
  action: SubagentDetails["action"],
  jobs: JobSnapshot[],
  extras: Pick<SubagentDetails, "activities" | "nextCursor" | "failures"> = {},
): SubagentDetails {
  return { action, jobs, ...extras };
}

function requireJobId(params: SubagentParamsType): string {
  if (!params.jobId) throw new Error(`action=${params.action} requires jobId`);
  return params.jobId;
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

export default function multiAgent(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Manage persistent background scout, feasibility, or reviewer jobs.",
      "Use action=start to launch and receive a job ID immediately.",
      "Use status, wait, result, abort, or list to control jobs later.",
      "wait defaults to five minutes, returns early when the child finishes, and never terminates it.",
      "Child sessions and activity logs are retained for later inspection.",
    ].join(" "),
    promptSnippet:
      "Start and control persistent background subagents with status, wait, result, abort, and list actions",
    promptGuidelines: [
      "Use subagent action=start only when context isolation, independent verification, or parallel investigation provides clear value.",
      "On action=start always provide summary: a one-line title (<= 160 chars) for the delegated work; the user sees it in the UI to understand what the subagent is for.",
      "After subagent action=start, retain the returned job ID and use action=wait, status, or result to observe it; wait defaults to 300 seconds and returns early on completion.",
      "Use subagent action=abort only after inspecting the job and deciding it should be stopped; cancelling a wait does not stop the child.",
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
          tasks.length > 1 &&
          tasks.some((task) => task.agent === "feasibility")
        ) {
          throw new Error("Feasibility cannot run in parallel mode");
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
          await confirmWorktree(task, ctx.cwd, ctx.hasUI, (title, message) =>
            ctx.ui.confirm(title, message),
          );
          const model = resolveModel(task, config.model, ctx.model);
          launchItems.push({ task, config, model });
        }

        const jobs: JobSnapshot[] = [];
        const failures: string[] = [];
        for (const item of launchItems) {
          const jobId = createJobId();
          let workspace: PreparedWorkspace | undefined;
          let feasibilityLease: LeaseHandle | undefined;
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
            startInvoked = true;
            const snapshot = await startJob({
              id: jobId,
              ...item,
              workspace,
              feasibilityLease,
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
          `Observe with action=wait (default ${DEFAULT_WAIT_SECONDS}s), status, or result.`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: details("start", jobs, { failures }),
        };
      }

      if (action === "list") {
        const jobs = await listJobSnapshots(params.limit ?? 20);
        const text = jobs.length
          ? jobs.map(snapshotLine).join("\n")
          : "No retained subagent jobs.";
        return {
          content: [{ type: "text", text }],
          details: details("list", jobs),
        };
      }

      const jobId = requireJobId(params);
      if (action === "status") {
        const snapshot = await getJobSnapshot(jobId);
        return {
          content: [{ type: "text", text: snapshotText(snapshot) }],
          details: details("status", [snapshot]),
        };
      }

      if (action === "wait") {
        const waitSeconds = params.waitSeconds ?? DEFAULT_WAIT_SECONDS;
        const snapshot = await waitForJob(
          jobId,
          waitSeconds,
          signal,
          (current) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting up to ${formatDuration(waitSeconds * 1000)}; ${snapshotLine(current)}`,
                },
              ],
              details: details("wait", [current]),
            });
          },
        );
        const reason = TERMINAL_JOB_STATES.has(snapshot.job.state)
          ? `Subagent reached terminal state: ${snapshot.job.state}`
          : `Observation wait ended after ${formatDuration(waitSeconds * 1000)}; subagent continues running.`;
        return {
          content: [
            { type: "text", text: `${reason}\n\n${snapshotText(snapshot)}` },
          ],
          details: details("wait", [snapshot]),
        };
      }

      if (action === "result") {
        const result = await getJobResult(
          jobId,
          params.cursor ?? 0,
          params.limit ?? 100,
        );
        const eventLines = result.activities.map(
          (event) =>
            `${event.seq} ${event.timestamp} ${event.type}${event.toolName ? ` ${event.toolName}` : ""}${event.summary ? `: ${event.summary}` : ""}`,
        );
        const output =
          result.finalOutput ||
          result.live.partialAssistantOutput ||
          result.live.latestCompletedOutput ||
          "(no assistant output yet)";
        const text = [
          snapshotText(result, { includeOutputs: false }),
          "",
          `activity cursor: ${result.nextCursor}`,
          ...(eventLines.length
            ? ["recent activity:", ...boundedActivityText(eventLines)]
            : []),
          "",
          result.finalOutput ? "final output:" : "current output:",
          truncateOutput(output),
        ].join("\n");
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
      if (action === "start" && args.agent) {
        text += ` ${theme.fg("accent", args.agent)} [${args.workspace ?? "research"}]`;
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
      if (content?.type === "text" && info.action === "result") {
        container.addChild(new Spacer(1));
        container.addChild(
          new Markdown(content.text, 0, 0, getMarkdownTheme()),
        );
      }
      return container;
    },
  });

  pi.registerCommand("agent-jobs", {
    description: "List, inspect, abort, or clean retained subagent jobs",
    async handler(args, ctx) {
      const [action, id] = args.trim().split(/\s+/, 2);
      if (!action || action === "list") {
        const jobs = await listJobSnapshots(50);
        ctx.ui.notify(
          jobs.length
            ? jobs.map(snapshotLine).join("\n")
            : "No retained subagent jobs.",
          "info",
        );
        return;
      }
      if (!id) {
        ctx.ui.notify(
          "Usage: /agent-jobs <status|abort|clean> <job-id>",
          "warning",
        );
        return;
      }
      if (action === "status") {
        ctx.ui.notify(snapshotText(await getJobSnapshot(id)), "info");
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
