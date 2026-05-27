/**
 * Security Extension
 *
 * Unified security guardrails for pi agent:
 *   1. Permission gate  - confirm/block dangerous bash commands (with model reasoning)
 *   2. Protected paths   - block writes/deletes to sensitive paths
 *   3. Destructive guard - confirm before clearing or switching sessions
 *
 * Commands:
 *   /security-log view [N]  - show recent log entries (default: 20)
 *   /security-log stats      - show summary statistics
 *   /security-log clear      - clear all logs (requires confirmation)
 */

import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { writeLog, readLogs, clearLogs, getLogStats } from "./logger";

export default function (pi: ExtensionAPI) {
  // =========================================================================
  // Helper: extract model's reasoning for a dangerous command
  // =========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getModelReasoning(ctx: any): string {
    const entries = ctx.sessionManager.getEntries();

    // Find the most recent assistant message
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message" || !entry.message) continue;
      if (entry.message.role !== "assistant") continue;

      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      // Collect TextContent blocks (model's explanation before the tool call)
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text && block.text.trim()) {
          textParts.push(block.text.trim());
        }
      }

      if (textParts.length > 0) {
        const combined = textParts.join("\n\n");
        // Trim to reasonable length for display (300 chars)
        if (combined.length > 300) {
          return combined.slice(0, 300) + "...";
        }
        return combined;
      }

      // Fallback: try ThinkingContent if no text
      for (const block of content) {
        if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
          const thinking = block.thinking.trim();
          if (thinking.length > 300) {
            return "(from thinking) " + thinking.slice(0, 300) + "...";
          }
          return "(from thinking) " + thinking;
        }
      }

      // Assistant message exists but has no text or thinking
      return "(no explanation provided)";
    }

    return "(no explanation provided)";
  }

  // =========================================================================
  // Module 1: Permission Gate (dangerous bash commands)
  // =========================================================================

  const dangerousPatterns: Array<{ pattern: RegExp; label: string }> = [
    // rm with recursive flag (any order, combined or separate)
    { pattern: /\brm\b.*\s-[a-zA-Z]*[rR][a-zA-Z]*\b/, label: "rm (recursive)" },
    { pattern: /\brm\b.*\s(--recursive|--force)\b/, label: "rm --recursive/--force" },

    // Disk-level destructive commands
    { pattern: /\b(dd|mkfs|fdisk|parted|wipefs)\b/, label: "disk-level operation" },

    // Redirect overwrite to block devices
    { pattern: />\s*\/dev\/(sd[a-z]|nvme|mmcblk)/, label: "redirect to block device" },

    // Pipe to shell
    { pattern: /\b(curl|wget)\b.*\|\s*(bash|sh|zsh)\b/, label: "pipe to shell" },

    // Permissive chmod
    { pattern: /\bchmod\b.*[0-7]*7[0-7]*7/, label: "chmod with permissive mode"},

    // chown to non-self
    { pattern: /\bchown\b/, label: "chown"},

    // Git destructive operations
    { pattern: /\bgit\s+push\b.*(--force|-f)\b/, label: "git push --force"},
    { pattern: /\bgit\s+reset\b.*(--hard|--merge)\b/, label: "git reset --hard"},
    { pattern: /\bgit\s+clean\b.*(-[a-z]*[f]|[f][a-z]*)\b/, label: "git clean -f"},

    // Move / copy overwriting important locations
    { pattern: /\b(mv|cp)\b.*\/(etc|boot|usr|var)\b/, label: "move/copy to system dir"},

    // sudo (log but don't block by default - user may need it)
    { pattern: /\bsudo\b/, label: "sudo"},

    // File truncation / overwrite with redirect
    { pattern: />\s*\/etc\//, label: "redirect to /etc/"},
    { pattern: />\s*~\/\.(ssh|gnupg|config)\//, label: "redirect to sensitive dotfile"},
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const matched = dangerousPatterns.find((p) => p.pattern.test(command));

    if (!matched) return undefined;

    // Special handling: sudo is logged but not auto-blocked
    if (matched.label === "sudo") {
      writeLog({
        timestamp: new Date().toISOString(),
        module: "gate",
        action: "allowed",
        tool: "bash",
        command: command,
        reason: "sudo detected (logged only)",
        userChoice: "auto-approved",
      });

      if (ctx.hasUI) {
        ctx.ui.notify(`sudo detected (allowed): ${command.slice(0, 60)}...`, "warning");
      }
      return undefined;
    }

    if (!ctx.hasUI) {
      writeLog({
        timestamp: new Date().toISOString(),
        module: "gate",
        action: "blocked",
        tool: "bash",
        command: command,
        reason: `matched: ${matched.label} (no UI)`,
        userChoice: "auto-blocked",
      });

      return {
        block: true,
        reason: `Dangerous command blocked: ${matched.label}. No UI available for confirmation.`,
      };
    }

    const reasoning = getModelReasoning(ctx);
    const theme = ctx.ui.theme;

    const confirmMessage = [
      `${theme.bold("Command:")} ${command}`,
      "",
      `${theme.bold("Reason:")} ${theme.fg("warning", reasoning)}`,
    ].join("\n");

    const approved = await ctx.ui.confirm(
      `Allow dangerous command? (${matched.label})`,
      confirmMessage,
    );

    if (!approved) {
      writeLog({
        timestamp: new Date().toISOString(),
        module: "gate",
        action: "blocked",
        tool: "bash",
        command: command,
        reason: `matched: ${matched.label}`,
        userChoice: "no",
      });
      return { block: true, reason: `Blocked by user: ${matched.label}` };
    }

    writeLog({
      timestamp: new Date().toISOString(),
      module: "gate",
      action: "allowed",
      tool: "bash",
      command: command,
      reason: `matched: ${matched.label}`,
      userChoice: "yes",
    });

    return undefined;
  });

  // =========================================================================
  // Module 2: Protected Paths (block writes/deletes to sensitive paths)
  // =========================================================================

  const protectedPrefixes = [
    ".git/",
    "node_modules/",
  ];

  const protectedExactNames = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.staging",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Gemfile.lock",
    "Cargo.lock",
    "poetry.lock",
  ];

  function extractFileName(p: string): string {
    // Normalize: remove trailing slash, get basename or last segment
    const normalized = p.replace(/\/+$/, "");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || normalized;
  }

  function isProtectedPath(p: string): string | null {
    const normalized = p.replace(/\/+$/, "");

    // Check prefix matches (e.g. .git/ anywhere in path)
    for (const prefix of protectedPrefixes) {
      if (normalized.includes("/" + prefix) || normalized.startsWith(prefix)) {
        return prefix;
      }
    }

    // Check exact directory name matches (e.g. node_modules as directory name)
    const segments = normalized.split("/");
    for (const seg of segments) {
      if (seg === "node_modules") return "node_modules/";
      if (seg === ".git") return ".git/";
    }

    // Check exact file name matches
    const fileName = extractFileName(normalized);
    for (const name of protectedExactNames) {
      if (fileName === name) return name;
    }

    // Check .env.* pattern
    if (/^\.env\./.test(fileName)) return fileName;

    return null;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const filePath = event.input.path as string;
    const matched = isProtectedPath(filePath);

    if (!matched) return undefined;

    writeLog({
      timestamp: new Date().toISOString(),
      module: "paths",
      action: "blocked",
      tool: event.toolName,
      path: filePath,
      reason: `protected: ${matched}`,
    });

    if (ctx.hasUI) {
      ctx.ui.notify(`Blocked write to protected path: ${filePath}`, "warning");
    }
    return { block: true, reason: `Path "${filePath}" is protected (matched: ${matched})` };
  });

  // Also block bash commands that delete protected paths
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // Match rm/mv commands that reference protected-looking paths
    const pathRefs = command.match(/(?:^|\s)([^\s]*\.env[^\s]*|[^\s]*\/\.git[^\s]*|[^\s]*node_modules[^\s]*)/g);
    if (!pathRefs) return undefined;

    for (const ref of pathRefs) {
      const cleaned = ref.trim();
      const matched = isProtectedPath(cleaned);
      if (matched) {
        writeLog({
          timestamp: new Date().toISOString(),
          module: "paths",
          action: "blocked",
          tool: "bash",
          command: command,
          path: cleaned,
          reason: `protected path in bash: ${matched}`,
        });

        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked bash command touching protected path: ${cleaned}`, "warning");
        }
        return { block: true, reason: `Bash command references protected path "${cleaned}"` };
      }
    }

    return undefined;
  });

  // =========================================================================
  // Module 3: Destructive Session Guard
  // =========================================================================

  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    if (!ctx.hasUI) return;

    if (event.reason === "new") {
      const confirmed = await ctx.ui.confirm(
        "Clear session?",
        "This will delete all messages in the current session.",
      );

      if (!confirmed) {
        writeLog({
          timestamp: new Date().toISOString(),
          module: "destructive",
          action: "cancelled",
          reason: "new session cancelled",
          userChoice: "no",
        });
        ctx.ui.notify("Clear cancelled", "info");
        return { cancel: true };
      }

      writeLog({
        timestamp: new Date().toISOString(),
        module: "destructive",
        action: "allowed",
        reason: "new session confirmed",
        userChoice: "yes",
      });
      return;
    }

    // reason === "resume" - check for unsaved work since last assistant response
    const entries = ctx.sessionManager.getEntries();

    // Find the last assistant message, then check if any user messages follow it
    let lastAssistantIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message.role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    // If no assistant has ever responded, all user messages are "unsaved"
    const hasUnsavedWork = lastAssistantIndex === -1
      ? entries.some((e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user")
      : entries.slice(lastAssistantIndex + 1).some(
          (e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
        );

    if (hasUnsavedWork) {
      const confirmed = await ctx.ui.confirm(
        "Switch session?",
        "You have unacknowledged messages in the current session. Switch anyway?",
      );

      if (!confirmed) {
        writeLog({
          timestamp: new Date().toISOString(),
          module: "destructive",
          action: "cancelled",
          reason: "session switch cancelled (unsaved work)",
          userChoice: "no",
        });
        ctx.ui.notify("Switch cancelled", "info");
        return { cancel: true };
      }

      writeLog({
        timestamp: new Date().toISOString(),
        module: "destructive",
        action: "allowed",
        reason: "session switch with unsaved work",
        userChoice: "yes",
      });
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select(
      `Fork from entry ${event.entryId.slice(0, 8)}?`,
      ["No, stay in current session", "Yes, create fork"],
    );

    if (choice !== "Yes, create fork") {
      writeLog({
        timestamp: new Date().toISOString(),
        module: "destructive",
        action: "cancelled",
        reason: "fork cancelled",
        userChoice: "no",
      });
      ctx.ui.notify("Fork cancelled", "info");
      return { cancel: true };
    }

    writeLog({
      timestamp: new Date().toISOString(),
      module: "destructive",
      action: "allowed",
      reason: `fork from ${event.entryId.slice(0, 8)}`,
      userChoice: "yes",
    });
  });

  // =========================================================================
  // Commands: /security-log
  // =========================================================================

  pi.registerCommand("security-log", {
    description: "View, clear, or get stats for the security log",
    async handler(args, ctx) {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0] || "view";

      if (subcmd === "clear") {
        const confirmed = await ctx.ui.confirm(
          "Clear security log?",
          "This will permanently delete all security log entries.",
        );
        if (confirmed) {
          clearLogs();
          ctx.ui.notify("Security log cleared.", "info");
        } else {
          ctx.ui.notify("Clear cancelled.", "info");
        }
        return;
      }

      if (subcmd === "stats") {
        const stats = getLogStats();
        const lines = [
          `Total entries: ${stats.total}`,
          "",
          "By module:",
          ...Object.entries(stats.byModule).map(([k, v]) => `  ${k}: ${v}`),
          "",
          "By action:",
          ...Object.entries(stats.byAction).map(([k, v]) => `  ${k}: ${v}`),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Default: view
      const count = parseInt(parts[1], 10) || 20;
      const logs = readLogs(count);
      if (logs.length === 0) {
        ctx.ui.notify("No security log entries.", "info");
        return;
      }

      const lines = logs.map((e) => {
        const ts = e.timestamp.slice(0, 19).replace("T", " ");
        const icon = e.action === "blocked" ? "BLOCK" : e.action === "allowed" ? "ALLOW" : "CANCEL";
        const detail = e.command
          ? e.command.slice(0, 50)
          : e.path
            ? e.path.slice(0, 50)
            : e.reason || "";
        return `[${ts}] ${icon} [${e.module}] ${detail}`;
      });

      ctx.ui.notify(`Security log (last ${logs.length}):\n${lines.join("\n")}`, "info");
    },
  });
}
