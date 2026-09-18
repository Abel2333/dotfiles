const AGENT_WORKSPACES = {
  scout: ["research"],
  reviewer: ["research"],
  feasibility: ["research", "scratch", "worktree"],
  implementer: ["project"],
};

/**
 * Resolve and validate the workspace mode for a delegated agent.
 *
 * @param {string} agent Delegated role name.
 * @param {string | undefined} requested Explicit workspace mode, if any.
 * @returns {string} The validated workspace mode.
 * @throws {Error} When the role does not support the requested mode.
 */
export function resolveAgentWorkspace(agent, requested) {
  const allowed = AGENT_WORKSPACES[agent];
  if (!allowed) throw new Error(`Unsupported subagent role: ${agent}`);

  const workspace =
    requested ?? (agent === "implementer" ? "project" : "research");
  if (!allowed.includes(workspace)) {
    throw new Error(
      `${agent} supports ${allowed.map((mode) => `'${mode}'`).join(" or ")} workspace mode only`,
    );
  }
  return workspace;
}

/**
 * Report whether an agent must run through the single-task dispatch path.
 *
 * @param {string} agent Delegated role name.
 * @returns {boolean} True for roles that may write or hold an exclusive lease.
 */
export function requiresSingleDispatch(agent) {
  return agent === "feasibility" || agent === "implementer";
}
