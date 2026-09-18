/**
 * Security logger - shared by all security modules.
 *
 * Logs to ~/.pi/agent/logs/security.log by default. Headless subagents may
 * override the directory so concurrent jobs retain independent audit logs.
 * Auto-rotates: max 2000 lines, oldest entries trimmed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const LOG_DIR = process.env.PI_SECURITY_LOG_DIR || path.join(getAgentDir(), "logs");
const LOG_FILE = path.join(LOG_DIR, "security.log");
const MAX_LINES = 2000;

// Cached line count so we can avoid reading the whole log on every write.
// null = not yet initialized (lazily counted on first write after load).
// jiti re-evaluates the module on /reload, so this resets per reload — that is
// fine since the first write after a reload re-counts from disk.
let cachedLineCount: number | null = null;

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
		if (cachedLineCount === null) {
			cachedLineCount = countLines();
		} else {
			cachedLineCount += 1;
		}
		if (cachedLineCount > MAX_LINES) {
			rotateIfNeeded();
		}
	} catch {
		// Silent failure - logging should never break the extension
	}
}

function countLines(): number {
	try {
		if (!fs.existsSync(LOG_FILE)) return 0;
		const content = fs.readFileSync(LOG_FILE, "utf-8");
		return content.split("\n").filter((l) => l.trim() !== "").length;
	} catch {
		return 0;
	}
}

function rotateIfNeeded(): void {
	try {
		const content = fs.readFileSync(LOG_FILE, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim() !== "");
		if (lines.length > MAX_LINES) {
			const trimmed = lines.slice(lines.length - MAX_LINES);
			fs.writeFileSync(LOG_FILE, trimmed.join("\n") + "\n", "utf-8");
			cachedLineCount = MAX_LINES;
		} else {
			cachedLineCount = lines.length;
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
		cachedLineCount = 0;
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
