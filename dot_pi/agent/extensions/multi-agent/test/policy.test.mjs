import assert from "node:assert/strict";
import test from "node:test";
import { requiresSingleDispatch, resolveAgentWorkspace } from "../policy.mjs";

test("resolveAgentWorkspace assigns role-specific defaults", () => {
  assert.equal(resolveAgentWorkspace("scout"), "research");
  assert.equal(resolveAgentWorkspace("reviewer"), "research");
  assert.equal(resolveAgentWorkspace("feasibility"), "research");
  assert.equal(resolveAgentWorkspace("implementer"), "project");
});

test("resolveAgentWorkspace rejects writable modes for the wrong role", () => {
  assert.throws(
    () => resolveAgentWorkspace("scout", "project"),
    /scout supports 'research'/,
  );
  assert.throws(
    () => resolveAgentWorkspace("implementer", "worktree"),
    /implementer supports 'project'/,
  );
  assert.throws(
    () => resolveAgentWorkspace("feasibility", "project"),
    /feasibility supports 'research' or 'scratch' or 'worktree'/,
  );
});

test("requiresSingleDispatch isolates writable roles", () => {
  assert.equal(requiresSingleDispatch("scout"), false);
  assert.equal(requiresSingleDispatch("reviewer"), false);
  assert.equal(requiresSingleDispatch("feasibility"), true);
  assert.equal(requiresSingleDispatch("implementer"), true);
});
