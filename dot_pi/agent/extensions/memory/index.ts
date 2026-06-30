/**
 * Memory extension for pi-agent.
 *
 * Provides conservative long-term memory:
 * - SQLite + FTS5 storage under ~/.pi/agent/memory/memory.db
 * - Small-model extraction after meaningful turns
 * - Deterministic recall and small automatic context injection
 * - Manual commands for search, list, forget, pin, and model selection
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { complete, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type MemoryScope = "user" | "project" | "env" | "task";
type MemoryKind = "preference" | "convention" | "fact" | "decision" | "todo";
type MemoryStatus = "active" | "stale" | "superseded";

interface MemoryConfig {
  enabled: boolean;
  extractionEnabled: boolean;
  useCurrentModelIfUnset: boolean;
  minConfidence: number;
  autoInjectEnabled: boolean;
  autoInjectMaxItems: number;
  autoInjectTokenBudget: number;
  extractorModel?: { provider: string; model: string };
  llmRerankEnabled: boolean;
}

interface MemoryRecord {
  id: number;
  scope: MemoryScope;
  project_key: string | null;
  kind: MemoryKind;
  subject: string;
  content: string;
  keywords: string;
  confidence: number;
  pinned: number;
  status: MemoryStatus;
  source_session: string | null;
  source_entry_ids: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  last_injected_at: string | null;
  expires_at: string | null;
}

interface ExtractedMemory {
  scope: MemoryScope;
  kind: MemoryKind;
  subject: string;
  content: string;
  keywords?: string[];
  confidence: number;
  ttlDays?: number | null;
  evidenceSource?: "user" | "tool" | "mixed" | "assistant" | "unknown";
  evidence?: string;
}

const MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "memory");
const CONFIG_FILE = path.join(MEMORY_DIR, "config.json");
const DB_FILE = path.join(MEMORY_DIR, "memory.db");
const CUSTOM_TYPE = "memory";

const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  extractionEnabled: true,
  useCurrentModelIfUnset: true,
  minConfidence: 0.72,
  autoInjectEnabled: true,
  autoInjectMaxItems: 6,
  autoInjectTokenBudget: 600,
  llmRerankEnabled: false,
};

const EXTRACTION_SYSTEM_PROMPT = `You extract durable long-term memories for a coding agent.

Return JSON only, with this shape:
{
  "memories": [
    {
      "scope": "user" | "project" | "env" | "task",
      "kind": "preference" | "convention" | "fact" | "decision" | "todo",
      "subject": "short stable key",
      "content": "one concise memory sentence",
      "keywords": ["keyword"],
      "confidence": 0.0,
      "ttlDays": null,
      "evidenceSource": "user" | "tool" | "mixed" | "assistant" | "unknown",
      "evidence": "short quote or summary of the supporting user/tool evidence"
    }
  ]
}

Only extract memories likely useful in future sessions.
Do not extract one-off questions, guesses, temporary logs, or facts not supported by the conversation.
Do not extract secrets, API keys, tokens, passwords, credential values, or auth file contents.
Do not invent dates. If a date matters, use only dates explicitly present in the conversation or the provided current date/time.
Use higher confidence only when the user explicitly stated it or tool output verified it.
Assistant explanations, plans, and guesses are not durable evidence by themselves.
For code, config, dependency, filesystem, installed-version, or environment facts, only extract when evidenceSource is "user", "tool", or "mixed".
If a code/config change is only claimed by the assistant and not confirmed by user text or tool output, do not extract it.
If nothing durable should be remembered, return {"memories":[]}.`;

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadConfig(): MemoryConfig {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Partial<MemoryConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: MemoryConfig): void {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function openDb(): DatabaseSync {
  ensureDir();
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      project_key TEXT,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      source_session TEXT,
      source_entry_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_injected_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      subject,
      content,
      keywords,
      content='memories',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid, subject, content, keywords)
      VALUES (new.id, new.subject, new.content, new.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, subject, content, keywords)
      VALUES ('delete', old.id, old.subject, old.content, old.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, subject, content, keywords)
      VALUES ('delete', old.id, old.subject, old.content, old.keywords);
      INSERT INTO memory_fts(rowid, subject, content, keywords)
      VALUES (new.id, new.subject, new.content, new.keywords);
    END;
  `);
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentTimeContext(): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  return `Current date/time: ${local}; timezone: ${timeZone}; ISO: ${now.toISOString()}.`;
}

function toProjectKey(cwd: string): string {
  return cwd.replace(os.homedir(), "~");
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_./~-]+/gu, " ")
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2)
        .slice(0, 80),
    ),
  );
}

function sanitizeFtsQuery(query: string): string {
  const terms = tokenize(query)
    .filter((term) => !/[:"*]/.test(term))
    .slice(0, 12);
  return terms.length > 0 ? terms.map((term) => `"${term}"`).join(" OR ") : "";
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    } else if (typed.type === "toolCall" && typeof typed.name === "string") {
      parts.push(`Tool call: ${typed.name} ${JSON.stringify(typed.arguments ?? {})}`);
    }
  }
  return parts;
}

function getRecentConversation(ctx: ExtensionContext, maxEntries = 8): { text: string; evidenceText: string; entryIds: string[] } {
  const branch = ctx.sessionManager.getBranch() as Array<{
    id?: string;
    type: string;
    message?: { role?: string; content?: unknown };
  }>;
  const chunks: string[] = [];
  const evidenceChunks: string[] = [];
  const entryIds: string[] = [];

  for (const entry of branch.slice(-maxEntries)) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const text = extractTextParts(entry.message.content).join("\n").trim();
    if (!text) continue;
    chunks.push(`${role}: ${text}`);
    if (role !== "assistant") evidenceChunks.push(`${role}: ${text}`);
    if (entry.id) entryIds.push(entry.id);
  }

  return { text: chunks.join("\n\n"), evidenceText: evidenceChunks.join("\n\n"), entryIds };
}

function getLastUserText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch() as Array<{
    type: string;
    message?: { role?: string; content?: unknown };
  }>;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    return extractTextParts(entry.message.content).join("\n").trim();
  }
  return "";
}

function shouldExtract(text: string): boolean {
  const normalized = text.toLowerCase();
  const patterns = [
    /remember|记住|以后|下次|默认|偏好|prefer|preference/,
    /不要|别|never|always|must|必须|应该/,
    /decision|决定|约定|convention|standard|workflow|流程/,
    /todo|待办|next step|后续|继续/,
    /verified|确认|事实|environment|环境|路径|命令/,
  ];
  return text.length >= 80 && patterns.some((pattern) => pattern.test(normalized));
}

function normalizeExtracted(input: unknown): ExtractedMemory[] {
  if (!input || typeof input !== "object") return [];
  const memories = (input as { memories?: unknown }).memories;
  if (!Array.isArray(memories)) return [];

  const validScopes = new Set<MemoryScope>(["user", "project", "env", "task"]);
  const validKinds = new Set<MemoryKind>(["preference", "convention", "fact", "decision", "todo"]);
  const validEvidenceSources = new Set(["user", "tool", "mixed", "assistant", "unknown"]);

  return memories
    .map((item): ExtractedMemory | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const scope = raw.scope;
      const kind = raw.kind;
      const subject = typeof raw.subject === "string" ? raw.subject.trim().slice(0, 120) : "";
      const content = typeof raw.content === "string" ? raw.content.trim().slice(0, 800) : "";
      const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
      if (!validScopes.has(scope as MemoryScope) || !validKinds.has(kind as MemoryKind)) return null;
      if (!subject || !content || confidence <= 0) return null;
      return {
        scope: scope as MemoryScope,
        kind: kind as MemoryKind,
        subject,
        content,
        keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === "string") : [],
        confidence,
        ttlDays: typeof raw.ttlDays === "number" ? raw.ttlDays : null,
        evidenceSource: typeof raw.evidenceSource === "string" && validEvidenceSources.has(raw.evidenceSource)
          ? raw.evidenceSource as ExtractedMemory["evidenceSource"]
          : "unknown",
        evidence: typeof raw.evidence === "string" ? raw.evidence.trim().slice(0, 300) : "",
      };
    })
    .filter((item): item is ExtractedMemory => item !== null);
}

function containsSecretLikeText(memory: ExtractedMemory): boolean {
  const text = `${memory.subject}\n${memory.content}\n${(memory.keywords ?? []).join(" ")}`.toLowerCase();
  const patterns = [
    /\bsk-[a-z0-9][a-z0-9_-]{6,}/i,
    /\b(api[_ -]?key|token|secret|password)\s*[:=]\s*['"]?[a-z0-9._-]{8,}/i,
    /\b(plaintext|contains|stores?|stored|saved).{0,60}\b(api[_ -]?key|token|secret|password|credential)\b/i,
    /\b(auth\.json|\.env).{0,80}\b(api[_ -]?key|token|secret|password|credential)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isEphemeralMemory(memory: ExtractedMemory): boolean {
  const text = `${memory.subject}\n${memory.content}`.toLowerCase();
  const patterns = [
    /\bcurrently contains no\b/,
    /\bno stored memories\b/,
    /\bas of this session\b/,
    /\bfile count\b/,
    /\bneeds to be added\b/,
    /\btemporary\b/,
    /\bone-off\b/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isPiAgentMemory(text: string): boolean {
  return /pi-agent|pi agent|~\/\.pi\/agent|\.pi\/agent|memory extension|extension|skill|hook|models\.json|settings\.json|trust\.json|auth\.json/i
    .test(text);
}

function requiresExternalEvidence(memory: ExtractedMemory): boolean {
  if (memory.kind === "preference") return false;

  const text = `${memory.subject}\n${memory.content}\n${(memory.keywords ?? []).join(" ")}`.toLowerCase();
  const codeOrEnvTarget = [
    isPiAgentMemory,
    /index\.ts|config\.json|settings\.json|models\.json|trust\.json|auth\.json|package\.json/,
    /injectcurrenttime|classifymemory|containssecretliketext|isephemeralmemory|before_agent_start/,
    /chezmoi|home-manager|\.pi\/agent|~\/\.pi\/agent|\.config|\.gnupg/,
    /\b(dependency|library|package|function|config|filesystem|installed)\b/,
  ].some((pattern) => typeof pattern === "function" ? pattern(text) : pattern.test(text));
  if (!codeOrEnvTarget) return false;

  const factualOrChangeClaim = [
    /\b(added|created|removed|deleted|changed|updated|simplified|renamed|moved|installed|configured|tracked|managed)\b/,
    /\b(exists|uses|sets|defines|contains|grants|auto-injects|no longer|is not tracked|is tracked)\b/,
    /新增|创建|删除|移除|修改|更新|简化|安装|配置|管理|跟踪|存在|使用|包含/,
  ].some((pattern) => pattern.test(text));
  return factualOrChangeClaim || memory.kind === "fact" || memory.kind === "decision";
}

function hasReliableEvidence(memory: ExtractedMemory): boolean {
  return memory.evidenceSource === "user" || memory.evidenceSource === "tool" || memory.evidenceSource === "mixed";
}

function hasNonAssistantSupport(memory: ExtractedMemory, evidenceText: string): boolean {
  if (!requiresExternalEvidence(memory)) return true;
  if (!hasReliableEvidence(memory)) return false;

  const haystack = evidenceText.toLowerCase();
  const evidence = (memory.evidence ?? "").trim().toLowerCase();
  if (evidence.length >= 20 && haystack.includes(evidence)) return true;
  if (evidence.length >= 10) return false;

  const evidenceTokens = tokenize(evidence).filter((token) => token.length >= 3);
  const memoryTokens = tokenize(`${memory.subject} ${memory.content}`).filter((token) => (
    token.length >= 6 || /[./_~-]/.test(token)
  ));
  const tokens = Array.from(new Set([...evidenceTokens, ...memoryTokens])).slice(0, 30);
  const overlap = tokens.filter((token) => haystack.includes(token)).length;

  return overlap >= Math.max(2, Math.ceil(tokens.length * 0.3));
}

function classifyMemory(memory: ExtractedMemory, cwd: string): ExtractedMemory | null {
  if (containsSecretLikeText(memory)) return null;
  if (isEphemeralMemory(memory)) return null;
  if (requiresExternalEvidence(memory) && !hasReliableEvidence(memory)) return null;

  const text = `${memory.subject}\n${memory.content}\n${(memory.keywords ?? []).join(" ")}`.toLowerCase();
  const classified: ExtractedMemory = { ...memory };

  const isDotfilesContext = /chezmoi|home-manager|\.chezmoiignore|\bdot_[a-z0-9_-]+/i.test(text);
  const isPiAgentContext = isPiAgentMemory(text);
  const isUserPreference = /user prefers|user preference|用户偏好|prefers|preference/.test(text);

  if (isDotfilesContext) {
    classified.scope = "project";
  } else if (isPiAgentContext) {
    classified.scope = "env";
  } else if (isUserPreference) {
    classified.scope = "user";
  } else if (classified.kind === "todo" || classified.scope === "task") {
    classified.scope = "task";
  }

  if ((classified.scope === "project" || classified.scope === "task") && cwd === os.homedir()) {
    // Avoid binding broad home-directory memories to "~" unless the model was explicit.
    if (!/project|repo|repository|home-manager|chezmoi|\.config/.test(text)) {
      classified.scope = isPiAgentContext ? "env" : classified.scope;
    }
  }

  return classified;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return JSON.parse(trimmed.slice(start, end + 1));
}

function sourceSession(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}

function upsertMemory(
  db: DatabaseSync,
  memory: ExtractedMemory,
  ctx: ExtensionContext,
  sourceEntryIds: string[],
): number | null {
  const config = loadConfig();
  if (memory.confidence < config.minConfidence) return null;
  const classified = classifyMemory(memory, ctx.cwd);
  if (!classified) return null;

  const projectKey = classified.scope === "project" || classified.scope === "task" ? toProjectKey(ctx.cwd) : null;
  const existing = db.prepare(
    `SELECT * FROM memories
     WHERE status = 'active'
       AND scope = ?
       AND IFNULL(project_key, '') = IFNULL(?, '')
       AND kind = ?
       AND lower(subject) = lower(?)
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(classified.scope, projectKey, classified.kind, classified.subject) as MemoryRecord | undefined;

  const now = nowIso();
  const keywords = Array.from(new Set([...(classified.keywords ?? []), ...tokenize(classified.subject), ...tokenize(classified.content)]))
    .slice(0, 40)
    .join(" ");
  const expiresAt = classified.ttlDays && classified.ttlDays > 0
    ? new Date(Date.now() + classified.ttlDays * 86400000).toISOString()
    : null;

  if (existing) {
    const isNewerOrMoreConfident = classified.confidence >= existing.confidence || classified.content.length > existing.content.length;
    if (isNewerOrMoreConfident) {
      db.prepare(
        `UPDATE memories
         SET content = ?, keywords = ?, confidence = ?, source_session = ?,
             source_entry_ids = ?, updated_at = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      ).run(
        classified.content,
        keywords,
        Math.max(classified.confidence, existing.confidence),
        sourceSession(ctx),
        JSON.stringify(sourceEntryIds),
        now,
        now,
        expiresAt,
        existing.id,
      );
      db.prepare("INSERT INTO memory_events(memory_id, action, details, created_at) VALUES (?, ?, ?, ?)")
        .run(existing.id, "updated", JSON.stringify({ subject: classified.subject }), now);
    } else {
      db.prepare("UPDATE memories SET last_seen_at = ?, confidence = max(confidence, ?) WHERE id = ?")
        .run(now, classified.confidence, existing.id);
    }
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO memories(
      scope, project_key, kind, subject, content, keywords, confidence, pinned,
      status, source_session, source_entry_ids, created_at, updated_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    classified.scope,
    projectKey,
    classified.kind,
    classified.subject,
    classified.content,
    keywords,
    classified.confidence,
    sourceSession(ctx),
    JSON.stringify(sourceEntryIds),
    now,
    now,
    now,
    expiresAt,
  );
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO memory_events(memory_id, action, details, created_at) VALUES (?, ?, ?, ?)")
    .run(id, "created", JSON.stringify({ subject: classified.subject }), now);
  return id;
}

function scopeAllowed(memory: MemoryRecord, cwd: string): boolean {
  if (memory.status !== "active") return false;
  if (memory.expires_at && new Date(memory.expires_at).getTime() < Date.now()) return false;
  if (memory.scope === "user" || memory.scope === "env") return true;
  return memory.project_key === toProjectKey(cwd);
}

function daysSince(iso: string | null): number {
  if (!iso) return 365;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 86400000);
}

function scoreMemory(memory: MemoryRecord, queryTokens: Set<string>, ftsScore = 0): number {
  const haystack = `${memory.subject} ${memory.content} ${memory.keywords}`.toLowerCase();
  let overlap = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) overlap += 1;
  }
  const textScore = Math.min(1, overlap / Math.max(3, queryTokens.size));
  const recency = Math.max(0, 1 - daysSince(memory.last_seen_at ?? memory.updated_at) / 180);
  const injectedPenalty = daysSince(memory.last_injected_at) < 0.5 ? 0.25 : 0;
  const stalePenalty = memory.status !== "active" ? 0.5 : 0;
  return (
    0.36 * textScore +
    0.2 * Math.max(0, Math.min(1, memory.confidence)) +
    0.14 * recency +
    0.12 * (memory.pinned ? 1 : 0) +
    0.1 * ftsScore +
    0.08 * (memory.kind === "preference" || memory.kind === "convention" ? 1 : 0) -
    injectedPenalty -
    stalePenalty
  );
}

function recallMemories(db: DatabaseSync, query: string, cwd: string, limit: number): Array<MemoryRecord & { score: number }> {
  const queryTokens = new Set(tokenize(`${query} ${cwd}`));
  const byId = new Map<number, MemoryRecord & { ftsScore?: number }>();
  const ftsQuery = sanitizeFtsQuery(query);

  if (ftsQuery) {
    const rows = db.prepare(
      `SELECT m.*, bm25(memory_fts) AS rank
       FROM memory_fts
       JOIN memories m ON m.id = memory_fts.rowid
       WHERE memory_fts MATCH ?
       ORDER BY rank
       LIMIT 40`,
    ).all(ftsQuery) as Array<MemoryRecord & { rank: number }>;
    for (const row of rows) {
      byId.set(row.id, { ...row, ftsScore: Math.max(0, Math.min(1, 1 / (1 + Math.abs(row.rank)))) });
    }
  }

  const pinned = db.prepare(
    `SELECT * FROM memories
     WHERE status = 'active'
       AND pinned = 1
       AND (scope IN ('user', 'env') OR project_key = ?)
     ORDER BY updated_at DESC
     LIMIT 30`,
  ).all(toProjectKey(cwd)) as MemoryRecord[];
  for (const row of pinned) byId.set(row.id, { ...row, ftsScore: byId.get(row.id)?.ftsScore ?? 0 });

  const recentProject = db.prepare(
    `SELECT * FROM memories
     WHERE status = 'active'
       AND (scope IN ('user', 'env') OR project_key = ?)
     ORDER BY updated_at DESC
     LIMIT 80`,
  ).all(toProjectKey(cwd)) as MemoryRecord[];
  for (const row of recentProject) byId.set(row.id, { ...row, ftsScore: byId.get(row.id)?.ftsScore ?? 0 });

  return Array.from(byId.values())
    .filter((memory) => scopeAllowed(memory, cwd))
    .map((memory) => ({ ...memory, score: scoreMemory(memory, queryTokens, memory.ftsScore ?? 0) }))
    .filter((memory) => memory.score > 0.12 || memory.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatMemory(memory: MemoryRecord & { score?: number }, includeMeta = false): string {
  const meta = includeMeta
    ? ` [${memory.id}, ${memory.scope}/${memory.kind}, conf ${memory.confidence.toFixed(2)}${memory.pinned ? ", pinned" : ""}]`
    : "";
  return `- ${memory.content}${meta}`;
}

function formatSearchResults(memories: Array<MemoryRecord & { score?: number }>): string {
  if (memories.length === 0) return "No matching memories.";
  return memories.map((memory) => formatMemory(memory, true)).join("\n");
}

function clampToBudget(lines: string[], tokenBudget: number): string[] {
  const selected: string[] = [];
  let approxTokens = 0;
  for (const line of lines) {
    const lineTokens = Math.ceil(line.length / 4);
    if (selected.length > 0 && approxTokens + lineTokens > tokenBudget) break;
    selected.push(line);
    approxTokens += lineTokens;
  }
  return selected;
}

async function resolveExtractorModel(ctx: ExtensionContext, config: MemoryConfig): Promise<Model<any> | undefined> {
  ctx.modelRegistry.refresh();
  if (config.extractorModel) {
    return ctx.modelRegistry.find(config.extractorModel.provider, config.extractorModel.model);
  }
  return config.useCurrentModelIfUnset ? ctx.model : undefined;
}

async function runExtraction(ctx: ExtensionContext, conversationText: string): Promise<ExtractedMemory[]> {
  const config = loadConfig();
  if (!config.enabled || !config.extractionEnabled) return [];
  const model = await resolveExtractorModel(ctx, config);
  if (!model) return [];

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return [];

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          currentTimeContext(),
          `Current cwd: ${ctx.cwd}`,
          "",
          "<conversation>",
          conversationText,
          "</conversation>",
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048, signal: ctx.getSignal?.() },
  );

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (!text.trim()) return [];
  return normalizeExtracted(parseJsonObject(text));
}

async function extractAndStore(ctx: ExtensionContext): Promise<number> {
  const { text, evidenceText, entryIds } = getRecentConversation(ctx, 10);
  if (!shouldExtract(evidenceText)) return 0;

  const db = openDb();
  try {
    const extracted = await runExtraction(ctx, text);
    let count = 0;
    for (const memory of extracted.slice(0, 8)) {
      if (!hasNonAssistantSupport(memory, evidenceText)) continue;
      const id = upsertMemory(db, memory, ctx, entryIds);
      if (id !== null) count += 1;
    }
    return count;
  } finally {
    db.close();
  }
}

function setMemoryStatus(id: number, status: MemoryStatus): boolean {
  const db = openDb();
  try {
    const result = db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
    if (result.changes > 0) {
      db.prepare("INSERT INTO memory_events(memory_id, action, details, created_at) VALUES (?, ?, ?, ?)")
        .run(id, status, "{}", nowIso());
    }
    return result.changes > 0;
  } finally {
    db.close();
  }
}

function setPinned(id: number, pinned: boolean): boolean {
  const db = openDb();
  try {
    const result = db.prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?")
      .run(pinned ? 1 : 0, nowIso(), id);
    if (result.changes > 0) {
      db.prepare("INSERT INTO memory_events(memory_id, action, details, created_at) VALUES (?, ?, ?, ?)")
        .run(id, pinned ? "pinned" : "unpinned", "{}", nowIso());
    }
    return result.changes > 0;
  } finally {
    db.close();
  }
}

function sendDisplayMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content,
      display: true,
    },
    { triggerTurn: false },
  );
}

function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("memory-status", {
    description: "Show memory extension status",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      const db = openDb();
      try {
        const total = db.prepare("SELECT count(*) AS count FROM memories WHERE status = 'active'").get() as { count: number };
        const model = config.extractorModel
          ? `${config.extractorModel.provider}/${config.extractorModel.model}`
          : config.useCurrentModelIfUnset
            ? "current conversation model"
            : "(unset)";
        sendDisplayMessage(
          pi,
          [
            "Memory status",
            "",
            `- Enabled: ${config.enabled}`,
            `- Active memories: ${total.count}`,
            `- Extractor model: ${model}`,
            `- Auto inject: ${config.autoInjectEnabled} (${config.autoInjectMaxItems} items, ~${config.autoInjectTokenBudget} tokens)`,
            `- Config: ${CONFIG_FILE}`,
            `- Database: ${DB_FILE}`,
          ].join("\n"),
        );
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("memory-search", {
    description: "Search long-term memories",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /memory-search <query>", "warning");
        return;
      }
      const db = openDb();
      try {
        const results = recallMemories(db, query, ctx.cwd, 12);
        sendDisplayMessage(pi, formatSearchResults(results));
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("memory-list", {
    description: "List recent active memories",
    handler: async (_args, ctx) => {
      const db = openDb();
      try {
        const rows = db.prepare(
          `SELECT * FROM memories
           WHERE status = 'active'
             AND (scope IN ('user', 'env') OR project_key = ?)
           ORDER BY pinned DESC, updated_at DESC
           LIMIT 30`,
        ).all(toProjectKey(ctx.cwd)) as MemoryRecord[];
        sendDisplayMessage(pi, formatSearchResults(rows));
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("memory-forget", {
    description: "Mark a memory as stale by id",
    handler: async (args, ctx) => {
      const id = Number.parseInt(args.trim(), 10);
      if (!Number.isFinite(id)) {
        ctx.ui.notify("Usage: /memory-forget <id>", "warning");
        return;
      }
      ctx.ui.notify(setMemoryStatus(id, "stale") ? `Memory ${id} marked stale` : `Memory ${id} not found`, "info");
    },
  });

  pi.registerCommand("memory-pin", {
    description: "Pin or unpin a memory by id",
    handler: async (args, ctx) => {
      const [idText, valueText] = args.trim().split(/\s+/);
      const id = Number.parseInt(idText, 10);
      if (!Number.isFinite(id)) {
        ctx.ui.notify("Usage: /memory-pin <id> [on|off]", "warning");
        return;
      }
      const pinned = valueText?.toLowerCase() === "off" ? false : true;
      ctx.ui.notify(setPinned(id, pinned) ? `Memory ${id} ${pinned ? "pinned" : "unpinned"}` : `Memory ${id} not found`, "info");
    },
  });

  pi.registerCommand("memory-model", {
    description: "Set the small model used for memory extraction",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const config = loadConfig();
      const arg = args.trim();

      if (arg) {
        const [provider, model] = arg.split("/", 2);
        if (!provider || !model) {
          ctx.ui.notify("Usage: /memory-model <provider>/<model>", "warning");
          return;
        }
        ctx.modelRegistry.refresh();
        if (!ctx.modelRegistry.find(provider, model)) {
          ctx.ui.notify(`Model not found: ${provider}/${model}`, "warning");
          return;
        }
        saveConfig({ ...config, extractorModel: { provider, model } });
        ctx.ui.notify(`Memory extractor model set to ${provider}/${model}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /memory-model <provider>/<model>", "warning");
        return;
      }

      ctx.modelRegistry.refresh();
      const models = ctx.modelRegistry.getAvailable().slice(0, 80);
      if (models.length === 0) {
        ctx.ui.notify("No available models found", "warning");
        return;
      }
      const labels = models.map((model) => `${model.provider}/${model.id}`);
      const choice = await ctx.ui.select("Memory extractor model", labels);
      if (!choice) return;
      const [provider, model] = choice.split("/", 2);
      saveConfig({ ...config, extractorModel: { provider, model } });
      ctx.ui.notify(`Memory extractor model set to ${choice}`, "info");
    },
  });

  pi.registerCommand("memory-extract", {
    description: "Run memory extraction on recent conversation now",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Extracting memory candidates...", "info");
      const count = await extractAndStore(ctx);
      ctx.ui.notify(`Stored or updated ${count} memories`, "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  openDb().close();
  registerCommands(pi);

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search durable user, project, environment, and task memories. Use when current work may depend on previous preferences, project conventions, environment facts, or ongoing task context.",
    promptSnippet: "Search long-term memory for relevant user preferences, project conventions, environment facts, or task context.",
    promptGuidelines: [
      "Use memory_search before assuming persistent user preferences or project conventions that may have been discussed in prior sessions.",
      "Do not treat low-confidence memories as absolute truth; verify important project or environment facts when they affect file changes or commands.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query for relevant memories" }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of memories to return, default 8, max 20" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query = typeof params.query === "string" ? params.query : "";
      const limit = Math.min(Math.max(typeof params.limit === "number" ? params.limit : 8, 1), 20);
      const db = openDb();
      try {
        const results = recallMemories(db, query, ctx.cwd, limit);
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: {
            query,
            results: results.map((memory) => ({
              id: memory.id,
              scope: memory.scope,
              kind: memory.kind,
              subject: memory.subject,
              confidence: memory.confidence,
              score: memory.score,
              pinned: Boolean(memory.pinned),
            })),
          },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled) return undefined;

    const query = getLastUserText(ctx);

    if (!config.autoInjectEnabled || !query.trim()) {
      return undefined;
    }

    const db = openDb();
    try {
      const recalled = recallMemories(db, query, ctx.cwd, config.autoInjectMaxItems);
      if (recalled.length === 0) {
        return undefined;
      }

      const lines = clampToBudget(recalled.map((memory) => formatMemory(memory)), config.autoInjectTokenBudget);
      if (lines.length === 0) {
        return undefined;
      }

      const injectedAt = nowIso();
      for (const memory of recalled.slice(0, lines.length)) {
        db.prepare("UPDATE memories SET last_injected_at = ? WHERE id = ?").run(injectedAt, memory.id);
      }

      const contextLines: string[] = [];
      contextLines.push("Relevant memory:");
      contextLines.push(...lines);

      return {
        message: {
          customType: CUSTOM_TYPE,
          content: contextLines.join("\n").trim(),
          display: false,
          details: { memoryIds: recalled.slice(0, lines.length).map((memory) => memory.id) },
        },
      };
    } finally {
      db.close();
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.extractionEnabled) return;
    try {
      const count = await extractAndStore(ctx);
      if (count > 0 && ctx.hasUI) {
        ctx.ui.notify(`memory: stored or updated ${count}`, "info");
      }
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`memory extraction skipped: ${message.slice(0, 160)}`, "warning");
      }
    }
  });
}
