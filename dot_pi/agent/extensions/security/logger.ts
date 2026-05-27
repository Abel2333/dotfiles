/**
 * Security logger - shared by all security modules.
 *
 * Logs to ~/.pi/agent/logs/security.log in JSONL format.
 * Auto-rotates: max 2000 lines, oldest entries trimmed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "logs");
const LOG_FILE = path.join(LOG_DIR, "security.log");
const MAX_LINES = 2000;

export interface LogEntry {
  timestamp: string;
  module: "gate" | "paths" | "destructive";
  action: "blocked" | "allowed" | "cancelled";
  tool?: string;
  command?: string;
  path?: string;
  reason?: string;
  userChoice?: string;
}

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function writeLog(entry: LogEntry): void {
  try {
    ensureDir();
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(LOG_FILE, line, "utf-8");
    rotateIfNeeded();
  } catch {
    // Silent failure - logging should never break the extension
  }
}

function rotateIfNeeded(): void {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(lines.length - MAX_LINES);
      fs.writeFileSync(LOG_FILE, trimmed.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Silent
  }
}

export function readLogs(count?: number): LogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const entries = content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as LogEntry);
    if (count && count > 0) {
      return entries.slice(-count);
    }
    return entries;
  } catch {
    return [];
  }
}

export function clearLogs(): void {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  } catch {
    // Silent
  }
}

export function getLogStats(): { total: number; byModule: Record<string, number>; byAction: Record<string, number> } {
  const entries = readLogs();
  const byModule: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const e of entries) {
    byModule[e.module] = (byModule[e.module] || 0) + 1;
    byAction[e.action] = (byAction[e.action] || 0) + 1;
  }
  return { total: entries.length, byModule, byAction };
}
