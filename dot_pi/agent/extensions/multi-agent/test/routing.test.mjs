import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  ROUTING_PROFILE_FILE,
  parseRoutingProfile,
  readRoutingProfile,
  resolveRoutedModel,
} from "../routing.mjs";

test("local role routing applies valid profile preferences", async (t) => {
  const agentDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-ma-routing-present-"),
  );
  t.after(() => fs.promises.rm(agentDir, { recursive: true, force: true }));
  await fs.promises.writeFile(
    path.join(agentDir, ROUTING_PROFILE_FILE),
    `${JSON.stringify({ roles: { reviewer: "role-choice" } })}\n`,
  );

  assert.deepEqual(readRoutingProfile(agentDir), { reviewer: "role-choice" });
  assert.equal(
    resolveRoutedModel({
      agent: "reviewer",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "role-choice",
  );
});

test("absent and invalid routing profiles safely fall back", async (t) => {
  const agentDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-ma-routing-fallback-"),
  );
  t.after(() => fs.promises.rm(agentDir, { recursive: true, force: true }));

  assert.equal(readRoutingProfile(agentDir), undefined);
  assert.equal(
    resolveRoutedModel({
      agent: "scout",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "legacy-choice",
  );
  assert.equal(
    resolveRoutedModel({
      agent: "scout",
      agentDir,
      parentModel: "parent-choice",
    }),
    "parent-choice",
  );

  await fs.promises.writeFile(path.join(agentDir, ROUTING_PROFILE_FILE), "{");
  assert.equal(readRoutingProfile(agentDir), undefined);
  await fs.promises.writeFile(
    path.join(agentDir, ROUTING_PROFILE_FILE),
    `${JSON.stringify({ roles: { unknown: "ignored-choice" } })}\n`,
  );
  assert.equal(readRoutingProfile(agentDir), undefined);
  assert.equal(parseRoutingProfile({ roles: { scout: 7 } }), undefined);
});

test("routing precedence is task explicit then local role then legacy then parent", async (t) => {
  const agentDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-ma-routing-precedence-"),
  );
  t.after(() => fs.promises.rm(agentDir, { recursive: true, force: true }));
  await fs.promises.writeFile(
    path.join(agentDir, ROUTING_PROFILE_FILE),
    `${JSON.stringify({ roles: { implementer: "role-choice" } })}\n`,
  );

  assert.equal(
    resolveRoutedModel({
      taskModel: "task-choice",
      agent: "implementer",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "task-choice",
  );
  // A task model identical to the parent model is an explicit choice and must
  // be returned as-is instead of falling through to role or legacy defaults.
  assert.equal(
    resolveRoutedModel({
      taskModel: "parent-choice",
      agent: "implementer",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "parent-choice",
  );
  assert.equal(
    resolveRoutedModel({
      agent: "implementer",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "role-choice",
  );
  assert.equal(
    resolveRoutedModel({
      agent: "scout",
      agentDir,
      legacyModel: "legacy-choice",
      parentModel: "parent-choice",
    }),
    "legacy-choice",
  );
  assert.equal(
    resolveRoutedModel({
      agent: "scout",
      agentDir,
      parentModel: "parent-choice",
    }),
    "parent-choice",
  );
});
