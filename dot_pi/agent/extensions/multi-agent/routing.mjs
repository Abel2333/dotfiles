import * as fs from "node:fs";
import * as path from "node:path";

export const ROUTING_PROFILE_FILE = "multi-agent-routing.json";

const SUPPORTED_ROLES = new Set([
  "scout",
  "feasibility",
  "reviewer",
  "implementer",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function modelValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Parse one optional local role-routing profile without accepting unknown roles.
 *
 * A valid profile has the shape `{ "roles": { "reviewer": "..." } }`.
 * Undefined means the profile is absent or invalid and callers must fall back.
 */
export function parseRoutingProfile(value) {
  const root = asObject(value);
  const roles = asObject(root?.roles);
  if (!roles) return undefined;

  const preferences = {};
  for (const [role, model] of Object.entries(roles)) {
    if (!SUPPORTED_ROLES.has(role)) return undefined;
    const preference = modelValue(model);
    if (!preference) return undefined;
    preferences[role] = preference;
  }
  return preferences;
}

/**
 * Read the optional profile from the local agent directory.
 *
 * Invalid JSON, unreadable files, and invalid schema all resolve to undefined so
 * routing configuration can never block extension startup or task dispatch.
 */
export function readRoutingProfile(agentDir) {
  if (typeof agentDir !== "string" || !agentDir) return undefined;
  try {
    const content = fs.readFileSync(path.join(agentDir, ROUTING_PROFILE_FILE), "utf8");
    return parseRoutingProfile(JSON.parse(content));
  } catch {
    return undefined;
  }
}

/**
 * Resolve model routing with task input taking priority over every local default.
 *
 * @param options Routing values from the task, optional local profile, legacy role definition, and parent session.
 * @returns The first usable model preference, or undefined when no source provides one.
 */
export function resolveRoutedModel(options = {}) {
  const explicit = modelValue(options.taskModel);
  if (explicit) return explicit;

  const local = readRoutingProfile(options.agentDir)?.[options.agent];
  if (local) return local;

  return modelValue(options.legacyModel) ?? modelValue(options.parentModel);
}
