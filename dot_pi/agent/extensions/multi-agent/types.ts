import type { Message } from "@earendil-works/pi-ai";
import type { ApprovalRequest } from "../security/approval";

export type AgentName = "scout" | "feasibility" | "reviewer" | "implementer";
export type WorkspaceMode = "research" | "scratch" | "worktree" | "project";
export type ProcessIdentityState = "owned" | "dead" | "foreign" | "unverified";
export type JobState =
  | "queued"
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted"
  | "orphaned";

export interface AgentConfig {
  name: AgentName;
  description: string;
  model?: string;
  systemPrompt: string;
  filePath: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface LeaseReference {
  path: string;
  token: string;
  name: string;
  jobId?: string;
}

export interface LeaseHandle extends LeaseReference {
  version: 1;
  ownerPid: number;
  ownerStartToken: string;
  phase: "preparing" | "supervisor";
  createdAt: string;
  updatedAt?: string;
}

export interface WorkspaceRecord {
  id: string;
  jobId?: string;
  mode: "scratch" | "worktree";
  path: string;
  sourceRoot: string;
  repoRoot?: string;
  gitCommonDir?: string;
  createdAt: string;
  task: string;
}

export interface PreparedWorkspace {
  mode: WorkspaceMode;
  cwd: string;
  sourceRoot: string;
  writableRoot?: string;
  record?: WorkspaceRecord;
  lease?: LeaseHandle;
}

export interface DelegatedTask {
  agent: AgentName;
  task: string;
  summary: string;
  model?: string;
  workspace: WorkspaceMode;
}

export interface CurrentToolSnapshot {
  id: string;
  name: string;
  arguments: unknown;
  summary: string;
  startedAt: string;
  partialResult?: unknown;
}

export interface ActivityEvent {
  seq: number;
  timestamp: string;
  type: string;
  toolCallId?: string;
  toolName?: string;
  summary?: string;
  data?: unknown;
}

export interface JobLiveSnapshot {
  jobId: string;
  state: JobState;
  updatedAt: string;
  lastEventAt: string;
  activitySeq: number;
  activity: string;
  currentTool?: CurrentToolSnapshot;
  partialAssistantOutput?: string;
  latestCompletedOutput?: string;
  latestToolResult?: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentJobRecord {
  version: 1;
  id: string;
  agent: AgentName;
  task: string;
  summary?: string;
  mode: WorkspaceMode;
  model: string;
  state: JobState;
  cwd: string;
  sourceRoot: string;
  jobDir: string;
  sessionDir: string;
  sessionPath?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  abortRequestedAt?: string;
  workspace?: WorkspaceRecord;
  leases?: LeaseReference[];
}

export interface ProcessRecord {
  jobId: string;
  supervisorPid: number;
  supervisorStartToken?: string;
  phase?: "launching" | "supervisor";
  childPid?: number;
  childStartToken?: string;
  updatedAt: string;
}

export interface LaunchConfig {
  jobId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface JobSnapshot {
  job: SubagentJobRecord;
  live: JobLiveSnapshot;
  elapsedMs: number;
  toolElapsedMs?: number;
  processAlive?: boolean;
  childAlive?: boolean;
  supervisorIdentity: ProcessIdentityState;
  childIdentity: ProcessIdentityState;
  pendingApprovals?: ApprovalRequest[];
}

export interface JobResultSnapshot extends JobSnapshot {
  activities: ActivityEvent[];
  nextCursor: number;
  finalOutput?: string;
  messages?: Message[];
}

export interface SubagentDetails {
  action:
    "start" | "status" | "wait" | "result" | "abort" | "list" | "authorize";
  jobs: JobSnapshot[];
  activities?: ActivityEvent[];
  nextCursor?: number;
  failures?: string[];
}

export const TERMINAL_JOB_STATES = new Set<JobState>([
  "completed",
  "failed",
  "aborted",
  "orphaned",
]);
