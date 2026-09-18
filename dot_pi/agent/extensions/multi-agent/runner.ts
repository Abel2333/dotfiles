import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "./limits.mjs";
import type {
  AgentConfig,
  DelegatedTask,
  LaunchConfig,
  PreparedWorkspace,
} from "./types";

const OUTPUT_CAP = 128 * 1024;

export function getFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return "";
}

export function truncateOutput(output: string): string {
  return truncateUtf8(output, OUTPUT_CAP, {
    tailBytes: 32 * 1024,
    reportOmitted: true,
  });
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function toolsFor(task: DelegatedTask): string[] {
  if (task.agent === "scout") return ["read", "grep", "find", "ls"];
  if (task.agent === "reviewer") {
    return ["read", "grep", "find", "ls", "bash"];
  }
  if (task.workspace === "research") {
    return ["read", "grep", "find", "ls", "bash", "exa_search"];
  }
  return ["read", "grep", "find", "ls", "bash", "edit", "write", "exa_search"];
}

function dynamicInstructions(
  task: DelegatedTask,
  workspace: PreparedWorkspace,
): string {
  const lines = [
    "",
    "# Delegated workspace",
    `Role: ${task.agent}`,
    `Mode: ${task.workspace}`,
    `Original source root: ${workspace.sourceRoot}`,
  ];

  if (workspace.writableRoot) {
    lines.push(`Writable root: ${workspace.writableRoot}`);
    lines.push("You may write only inside the writable root.");
  } else {
    lines.push("No writable root is assigned. Remain read-only.");
  }

  if (task.workspace === "project") {
    lines.push(
      "You are modifying the current Git working tree directly. Preserve all existing changes and do not mutate Git state.",
    );
  } else if (task.workspace === "worktree") {
    lines.push(
      "This is a detached Git worktree based on HEAD. Changes are experimental and must not be committed or merged.",
    );
  } else if (task.workspace === "scratch") {
    lines.push(
      "Use the original source only as read-only reference. Build the minimal independent experiment in the scratch root.",
    );
  }

  lines.push(
    "The path and command guards are workflow protections, not a security sandbox.",
    "Do not invoke another agent.",
  );
  return lines.join("\n");
}

async function makeRuntimeDirs(
  jobDir: string,
): Promise<Record<string, string>> {
  const runtimeRoot = path.join(jobDir, "runtime");
  const dirs = {
    runtimeRoot,
    home: path.join(runtimeRoot, "home"),
    cache: path.join(runtimeRoot, "cache"),
    config: path.join(runtimeRoot, "config"),
    data: path.join(runtimeRoot, "data"),
    tmp: path.join(runtimeRoot, "tmp"),
  };
  for (const dir of Object.values(dirs)) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export async function prepareAgentLaunch(options: {
  jobId: string;
  jobDir: string;
  sessionDir: string;
  config: AgentConfig;
  task: DelegatedTask;
  model: string;
  workspace: PreparedWorkspace;
  guardPath: string;
}): Promise<LaunchConfig> {
  const {
    jobId,
    jobDir,
    sessionDir,
    config,
    task,
    model,
    workspace,
    guardPath,
  } = options;
  const dirs = await makeRuntimeDirs(jobDir);
  await fs.promises.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const promptPath = path.join(dirs.runtimeRoot, "prompt.md");
  const prompt = `${config.systemPrompt}\n${dynamicInstructions(task, workspace)}\n`;
  await fs.promises.writeFile(promptPath, prompt, {
    encoding: "utf8",
    mode: 0o600,
  });

  const sessionName = `[subagent:${task.agent}] ${task.task.replace(/\s+/g, " ").slice(0, 80)}`;
  const piArgs = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    sessionDir,
    "--session-id",
    jobId,
    "--name",
    sessionName,
    "--model",
    model,
    "--tools",
    toolsFor(task).join(","),
    "--exclude-tools",
    "subagent",
    "--extension",
    guardPath,
    "--append-system-prompt",
    promptPath,
    `Task: ${task.task}`,
  ];
  const invocation = getPiInvocation(piArgs);

  return {
    jobId,
    command: invocation.command,
    args: invocation.args,
    cwd: workspace.cwd,
    env: {
      HOME: dirs.home,
      XDG_CACHE_HOME: dirs.cache,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      TMPDIR: dirs.tmp,
      PI_CODING_AGENT_DIR: getAgentDir(),
      PI_MULTI_AGENT_ROLE: task.agent,
      PI_MULTI_AGENT_MODE: task.workspace,
      PI_MULTI_AGENT_SOURCE_ROOT: workspace.sourceRoot,
      PI_MULTI_AGENT_WRITABLE_ROOT: workspace.writableRoot ?? "",
      PI_MULTI_AGENT_RUNTIME_ROOT: dirs.runtimeRoot,
      PI_MULTI_AGENT_JOB_ID: jobId,
      PI_SECURITY_APPROVAL_DIR:
        task.agent === "implementer" ? path.join(jobDir, "approvals") : "",
      PI_SECURITY_POLICY_HOME: os.homedir(),
      PI_SECURITY_LOG_DIR: path.join(jobDir, "security-logs"),
    },
  };
}
