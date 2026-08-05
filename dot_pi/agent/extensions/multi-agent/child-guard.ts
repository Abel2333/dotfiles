import * as fs from "node:fs";
import * as path from "node:path";
import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AgentName, WorkspaceMode } from "./types";

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

const MUTATING_GIT_PATTERN =
  /\bgit\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(?:add|am|apply|bisect|branch|checkout|cherry-pick|clean|clone|commit|config|fetch|init|merge|mv|pull|push|rebase|remote|reset|restore|revert|rm|stash|switch|tag|worktree)\b/i;
const SYSTEM_INSTALL_PATTERN =
  /\b(?:sudo|doas|rpm-ostree|dnf|yum|apt(?:-get)?|pacman|zypper|apk|brew)\b/i;
const GLOBAL_INSTALL_PATTERN =
  /\b(?:npm|pnpm|yarn)\s+(?:install|add)\b[^\n]*(?:\s-g\b|--global\b)|\bpipx?\s+install\b[^\n]*--user\b|\bcargo\s+install\b|\bgo\s+install\b/i;

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function shellWords(segment: string): string[] {
  return (
    segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripQuotes) ?? []
  );
}

function findGitSubcommand(words: string[]): string | undefined {
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === "-C" || word === "--git-dir" || word === "--work-tree") {
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

export function checkReadOnlyBash(command: string): string | null {
  if (!command.trim()) return "Empty Bash command";
  if (/\n|\r|>|<|`|\$\(|\$\{|(?<!&)&(?!&)|\(|\)/.test(command)) {
    return "Read-only Bash does not allow redirects, substitutions, background jobs, or grouping";
  }

  const segments = command.split(/\|\||&&|\||;/).map((item) => item.trim());
  if (segments.some((item) => item.length === 0)) {
    return "Invalid or empty shell command segment";
  }

  for (const segment of segments) {
    const words = shellWords(segment);
    const executable = path.basename(words[0] ?? "");
    if (!READ_ONLY_COMMANDS.has(executable)) {
      return `Command is not in the read-only allowlist: ${executable || "unknown"}`;
    }
    if (executable === "git") {
      const subcommand = findGitSubcommand(words);
      if (!subcommand || !READ_ONLY_GIT_COMMANDS.has(subcommand)) {
        return `Git subcommand is not read-only: ${subcommand ?? "unknown"}`;
      }
    }
    if (
      executable === "find" &&
      words.some((word) =>
        ["-delete", "-exec", "-execdir", "-ok"].includes(word),
      )
    ) {
      return "Mutating find actions are not allowed";
    }
    if (
      executable === "rg" &&
      words.some((word) => word === "--pre" || word.startsWith("--pre="))
    ) {
      return "rg --pre is not allowed";
    }
  }
  return null;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function canonicalTarget(
  cwd: string,
  inputPath: string,
): Promise<string> {
  const raw = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const absolute = path.resolve(cwd, raw);
  let existing = absolute;
  const missing: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  const canonicalBase = await fs.promises.realpath(existing);
  return path.join(canonicalBase, ...missing);
}

async function validateWritePath(
  cwd: string,
  writableRoot: string,
  inputPath: string,
): Promise<string | null> {
  const root = await fs.promises.realpath(writableRoot);
  const target = await canonicalTarget(cwd, inputPath);
  if (!pathInside(root, target)) {
    return `Write target is outside the assigned workspace: ${inputPath}`;
  }
  const relative = path.relative(root, target);
  if (relative.split(path.sep).includes(".git")) {
    return "Writing Git metadata is not allowed";
  }
  return null;
}

async function validateBashWritePath(
  cwd: string,
  roots: string[],
  inputPath: string,
): Promise<string | null> {
  const target = await canonicalTarget(cwd, inputPath);
  for (const [index, candidateRoot] of roots.entries()) {
    const root = await fs.promises.realpath(candidateRoot);
    if (!pathInside(root, target)) continue;
    if (
      index === 0 &&
      path.relative(root, target).split(path.sep).includes(".git")
    ) {
      return "Writing Git metadata is not allowed";
    }
    return null;
  }
  return `Bash write target is outside the assigned workspace: ${inputPath}`;
}

function extractRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:\d*>>?|&>)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  for (const match of command.matchAll(pattern)) {
    targets.push(stripQuotes(match[1]));
  }
  return targets;
}

function extractMutationTargets(command: string): string[] {
  const targets: string[] = [];
  const segments = command.split(/\|\||&&|\||;/);
  for (const segment of segments) {
    const words = shellWords(segment.trim());
    if (words.length === 0) continue;
    const executable = path.basename(words[0]);
    const operands = words.slice(1).filter((word) => !word.startsWith("-"));
    if (
      [
        "rm",
        "rmdir",
        "mkdir",
        "touch",
        "truncate",
        "chmod",
        "chown",
        "tee",
      ].includes(executable)
    ) {
      targets.push(...operands);
    } else if (
      ["cp", "mv", "ln", "install"].includes(executable) &&
      operands.length > 0
    ) {
      targets.push(operands[operands.length - 1]);
    }
  }
  return targets;
}

export async function checkMutableBash(
  command: string,
  cwd: string,
  writableRoot: string,
  runtimeRoot?: string,
): Promise<string | null> {
  if (MUTATING_GIT_PATTERN.test(command)) {
    return "Mutating Git commands are not allowed in feasibility experiments";
  }
  for (const segment of command.split(/\|\||&&|\||;/)) {
    const words = shellWords(segment.trim());
    if (path.basename(words[0] ?? "") !== "git") continue;
    const subcommand = findGitSubcommand(words);
    if (!subcommand || !READ_ONLY_GIT_COMMANDS.has(subcommand)) {
      return `Git subcommand is not allowed in feasibility experiments: ${subcommand ?? "unknown"}`;
    }
  }
  if (SYSTEM_INSTALL_PATTERN.test(command)) {
    return "System-level package installation is not allowed";
  }
  if (/\bdd\b/.test(command)) {
    return "Raw dd operations are not allowed in feasibility experiments";
  }
  if (
    /\beval\b|\b(?:bash|sh|zsh|fish)\b[^\n]*(?:\s-c\b|\s-lc\b)/.test(command)
  ) {
    return "Nested shell evaluation is not allowed in feasibility experiments";
  }
  if (GLOBAL_INSTALL_PATTERN.test(command)) {
    return "Global or user-level package installation is not allowed";
  }
  if (
    /\b(?:HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|PI_CODING_AGENT_DIR)\s*=/.test(
      command,
    )
  ) {
    return "Overriding protected environment paths is not allowed";
  }
  if (/\bcd\s+(?:\.\.(?:\/|\b)|\/|~)/.test(command)) {
    return "Changing to a directory outside the experiment workspace is not allowed";
  }

  const targets = [
    ...extractRedirectTargets(command),
    ...extractMutationTargets(command),
  ];
  for (const target of targets) {
    if (target === "/dev/null" || target.startsWith("/dev/fd/")) continue;
    if (/[$*?{}\[\]]/.test(target)) {
      return `Cannot safely validate dynamic write target: ${target}`;
    }
    const violation = await validateBashWritePath(
      cwd,
      [writableRoot, runtimeRoot].filter((root): root is string =>
        Boolean(root),
      ),
      target,
    );
    if (violation) return violation;
  }
  return null;
}

export default function childGuard(pi: ExtensionAPI) {
  const role = process.env.PI_MULTI_AGENT_ROLE as AgentName | undefined;
  const mode = process.env.PI_MULTI_AGENT_MODE as WorkspaceMode | undefined;
  const writableRoot = process.env.PI_MULTI_AGENT_WRITABLE_ROOT;
  const runtimeRoot = process.env.PI_MULTI_AGENT_RUNTIME_ROOT;
  if (!role || !mode) return;

  const readOnly = role !== "feasibility" || mode === "research";

  pi.on("tool_call", async (event, ctx) => {
    const writePath = isToolCallEventType("write", event)
      ? event.input.path
      : isToolCallEventType("edit", event)
        ? event.input.path
        : undefined;
    if (writePath !== undefined) {
      if (readOnly || !writableRoot) {
        return { block: true, reason: `${role} is read-only in ${mode} mode` };
      }
      const reason = await validateWritePath(ctx.cwd, writableRoot, writePath);
      if (reason) return { block: true, reason };
      return;
    }

    if (isToolCallEventType("bash", event)) {
      const reason = readOnly
        ? checkReadOnlyBash(event.input.command)
        : await checkMutableBash(
            event.input.command,
            ctx.cwd,
            writableRoot!,
            runtimeRoot,
          );
      if (reason) return { block: true, reason };
    }
  });
}
