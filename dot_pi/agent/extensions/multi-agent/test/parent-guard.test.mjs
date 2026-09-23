import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLORATION_BUDGET_LIMIT,
  PARENT_GUARDED_TOOL_NAMES,
  collectBranchDelegation,
  evaluateParentToolCall as evaluateRawParentToolCall,
  isNarrowVerificationBash,
  isReadOnlyBash,
} from "../parent-guard.mjs";

function evaluateParentToolCall(event, options = {}) {
  return evaluateRawParentToolCall(event, { env: {}, ...options });
}

function user(id) {
  return {
    type: "message",
    id,
    message: { role: "user", content: "delegated task" },
  };
}

function startCall(id, agent) {
  return {
    type: "message",
    id: `${id}-assistant`,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "subagent",
          arguments: {
            action: "start",
            agent,
            task: "delegated task",
          },
        },
      ],
    },
  };
}

function job(id, agent, state) {
  return { job: { id, agent, state } };
}

function subagentResult(id, action, jobs) {
  return {
    type: "message",
    id: `${id}-result`,
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "subagent",
      details: { action, jobs },
    },
  };
}

function workflowBranch(agent, state = "completed") {
  const id = `${agent}-job`;
  return [
    user("workflow-user"),
    startCall(id, agent),
    subagentResult(id, "start", [job(id, agent, state)]),
  ];
}

function continuationBranch(firstState, secondState) {
  const id = "implementer-continuation";
  return [
    ...workflowBranch("implementer", firstState),
    user("continuation-user"),
    startCall(id, "implementer"),
    subagentResult(id, "start", [job(id, "implementer", secondState)]),
  ];
}

function event(toolName) {
  const input = {
    read: { path: "src/file.ts" },
    grep: { pattern: "text", path: "src" },
    find: { pattern: "*.ts", path: "src" },
    ls: { path: "src" },
    bash: { command: "git status --short" },
    powershell: { command: "Get-ChildItem" },
    edit: { path: "src/file.ts" },
    write: { path: "src/file.ts" },
    subagent: { action: "status", jobId: "job" },
  };
  return { toolName, input: input[toolName] ?? {} };
}

function bashEvent(command) {
  return { toolName: "bash", input: { command } };
}

test("active jobs created on the current branch block all broad parent tools", async () => {
  const branch = workflowBranch("scout", "running");
  const state = collectBranchDelegation(branch);
  assert.equal(state.activeJobs.length, 1);

  for (const toolName of PARENT_GUARDED_TOOL_NAMES) {
    const result = await evaluateParentToolCall(event(toolName), { branch });
    assert.equal(result?.block, true, `${toolName} should be blocked`);
    assert.match(result.reason, /current-branch subagent job/);
  }
});

test("a same-batch subagent start blocks broad sibling tools but not its own start", async () => {
  const branch = [user("same-batch-user"), startCall("same-batch-start", "scout")];
  assert.equal(
    await evaluateParentToolCall(event("subagent"), { branch }),
    undefined,
  );

  for (const toolName of PARENT_GUARDED_TOOL_NAMES) {
    const result = await evaluateParentToolCall(event(toolName), { branch });
    assert.equal(result?.block, true, `${toolName} should be blocked with pending start`);
    assert.match(result.reason, /pending start same-batch-start/);
  }
});

test("unrelated status lookups and terminal branch jobs do not block parent tools", async () => {
  const unrelated = [
    user("unrelated-user"),
    subagentResult("unrelated-status", "status", [
      job("other-session-job", "scout", "running"),
    ]),
  ];
  assert.equal(collectBranchDelegation(unrelated).activeJobs.length, 0);
  assert.equal(
    await evaluateParentToolCall(event("read"), { branch: unrelated }),
    undefined,
  );

  const terminal = workflowBranch("scout", "completed");
  assert.equal(collectBranchDelegation(terminal).activeJobs.length, 0);
  assert.equal(
    await evaluateParentToolCall(event("read"), { branch: terminal }),
    undefined,
  );
});

test("delegated children bypass parent branch restrictions", async () => {
  const branch = workflowBranch("scout", "running");
  assert.equal(
    await evaluateParentToolCall(event("write"), {
      branch,
      env: { PI_MULTI_AGENT_ROLE: "scout" },
    }),
    undefined,
  );
});

test("stale non-terminal branch snapshots are refreshed against retained jobs", async () => {
  const branch = workflowBranch("scout", "running");

  const cleaned = await evaluateParentToolCall(event("read"), {
    branch,
    resolveJob: async () => undefined,
  });
  assert.equal(cleaned, undefined);

  const live = await evaluateParentToolCall(event("read"), {
    branch,
    resolveJob: async () => job("scout-job", "scout", "running"),
  });
  assert.equal(live?.block, true);

  const completed = await evaluateParentToolCall(event("read"), {
    branch,
    resolveJob: async () => job("scout-job", "scout", "completed"),
  });
  assert.equal(completed, undefined);
});

test("a lookup error does not clear a genuinely active job", async () => {
  const branch = workflowBranch("scout", "running");
  const result = await evaluateParentToolCall(event("read"), {
    branch,
    resolveJob: async () => {
      throw new Error("unrelated lookup failure");
    },
  });
  assert.equal(result?.block, true);

  const withUnrelatedErrorResult = [
    ...workflowBranch("scout", "running"),
    {
      type: "message",
      id: "unrelated-error",
      message: {
        role: "toolResult",
        toolCallId: "unrelated-status",
        toolName: "subagent",
        isError: true,
        details: { action: "status", jobs: [] },
      },
    },
  ];
  const stillActive = await evaluateParentToolCall(event("read"), {
    branch: withUnrelatedErrorResult,
    resolveJob: async (reference) => job(reference, "scout", "running"),
  });
  assert.equal(stillActive?.block, true);
});

test("same-batch pending starts survive live refresh of other jobs", async () => {
  const branch = [user("batch-user"), startCall("batch-start", "scout")];
  const result = await evaluateParentToolCall(event("read"), {
    branch,
    resolveJob: async () => undefined,
  });
  assert.equal(result?.block, true);
  assert.match(result.reason, /pending start batch-start/);
});

test("strict mode blocks project writes after a workflow while preserving plans", async () => {
  const branch = workflowBranch("implementer");
  const blockedEdit = await evaluateParentToolCall(event("edit"), {
    branch,
    cwd: "/workspace/project",
  });
  assert.equal(blockedEdit?.block, true);
  assert.match(blockedEdit.reason, /parent project edits remain blocked/);

  assert.equal(
    await evaluateParentToolCall(
      { toolName: "edit", input: { path: "plans/accepted-plan.md" } },
      { branch, cwd: "/workspace/project" },
    ),
    undefined,
  );
  assert.equal(
    await evaluateParentToolCall(
      { toolName: "write", input: { path: "/workspace/project/plans/note.md" } },
      { branch, cwd: "/workspace/project" },
    ),
    undefined,
  );

  const mutatingBash = await evaluateParentToolCall(
    { toolName: "bash", input: { command: "git commit -m update" } },
    { branch, cwd: "/workspace/project" },
  );
  assert.equal(mutatingBash?.block, true);
  assert.match(mutatingBash.reason, /parent project edits remain blocked/);
  assert.equal(
    await evaluateParentToolCall(
      { toolName: "bash", input: { command: "git diff --check" } },
      { branch, cwd: "/workspace/project" },
    ),
    undefined,
  );
  assert.equal(isReadOnlyBash("sort -o output.txt input.txt"), false);
});

test("reviewer workflow routes findings to remediation and direct mode is an escape", async () => {
  const reviewerBranch = workflowBranch("reviewer");
  const strict = await evaluateParentToolCall(event("write"), {
    branch: reviewerBranch,
    cwd: "/workspace/project",
  });
  assert.equal(strict?.block, true);
  assert.match(strict.reason, /Reviewer findings must be sent to a remediation implementer/);
  assert.match(strict.reason, /parent-accepted Finding IDs/);

  assert.equal(
    await evaluateParentToolCall(event("write"), {
      branch: reviewerBranch,
      cwd: "/workspace/project",
      mode: "direct",
    }),
    undefined,
  );
});

test("failed implementer continuation lock persists across later user messages", async () => {
  const failed = workflowBranch("implementer", "failed");
  const firstTurn = await evaluateParentToolCall(event("edit"), {
    branch: failed,
    cwd: "/workspace/project",
  });
  assert.equal(firstTurn?.block, true);
  assert.match(firstTurn.reason, /continuation implementer/);

  const laterTurn = [...failed, user("next-user-turn")];
  for (const toolName of ["edit", "write", "powershell"]) {
    const result = await evaluateParentToolCall(event(toolName), {
      branch: laterTurn,
      cwd: "/workspace/project",
    });
    assert.equal(result?.block, true, `${toolName} should stay blocked`);
    assert.match(result.reason, /continuation implementer/);
  }
  const mutatingBash = await evaluateParentToolCall(
    { toolName: "bash", input: { command: "git commit -am update" } },
    { branch: laterTurn, cwd: "/workspace/project" },
  );
  assert.equal(mutatingBash?.block, true);
  assert.equal(
    await evaluateParentToolCall(
      { toolName: "write", input: { path: "plans/note.md" } },
      { branch: laterTurn, cwd: "/workspace/project" },
    ),
    undefined,
  );
});

test("a later completed implementer clears the continuation lock", async () => {
  const completedContinuation = continuationBranch("failed", "completed");
  const sameTurn = await evaluateParentToolCall(event("edit"), {
    branch: completedContinuation,
    cwd: "/workspace/project",
  });
  assert.equal(sameTurn?.block, true);

  const thirdTurn = [...completedContinuation, user("third-user-turn")];
  assert.equal(
    await evaluateParentToolCall(event("edit"), {
      branch: thirdTurn,
      cwd: "/workspace/project",
    }),
    undefined,
  );
});

test("a later failed continuation stays unresolved and a running one stays protected", async () => {
  const failedAgain = [
    ...continuationBranch("failed", "failed"),
    user("third-user-turn"),
  ];
  const blocked = await evaluateParentToolCall(event("edit"), {
    branch: failedAgain,
    cwd: "/workspace/project",
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /continuation implementer/);

  const running = continuationBranch("failed", "running");
  const protectedResult = await evaluateParentToolCall(event("read"), {
    branch: running,
    resolveJob: async (reference) => job(reference, "implementer", "running"),
  });
  assert.equal(protectedResult?.block, true);

  assert.equal(
    await evaluateParentToolCall(event("edit"), {
      branch: failedAgain,
      cwd: "/workspace/project",
      mode: "direct",
    }),
    undefined,
  );
});

test("read-only bash rejects git output, config, and fd exec escapes", () => {
  const rejected = [
    "git diff --output=src/file.ts",
    "git log --output build/log.txt",
    "git show --output=out.patch HEAD",
    "git -c diff.external=evil diff",
    "git --config-env=diff.external=ENV diff",
    "git diff --ext-diff",
    "git diff --textconv",
    "fd -x rm",
    "fd --exec rm",
    "fd -X rm",
    "fd --exec-batch=rm",
    "fd --exec-batch rm",
    "sort -o output.txt input.txt",
  ];
  for (const command of rejected) {
    assert.equal(isReadOnlyBash(command), false, command);
  }

  const allowed = [
    "git diff --check",
    "git diff --stat",
    "git status --short",
    "git log --oneline -5",
    "git show HEAD",
    "fd -e ts pattern src",
    "fd pattern src",
    "find src -name '*.ts'",
    "rg pattern src",
  ];
  for (const command of allowed) {
    assert.equal(isReadOnlyBash(command), true, command);
  }
});

test("narrow verification rejects chaining, control syntax, and second commands", () => {
  const rejected = [
    "pytest ; git commit -am x",
    "pytest && git commit -am x",
    "node --test test/x.test.mjs && git commit -am x",
    "node --test test/x.test.mjs || true",
    "node --test test/x.test.mjs | tee out.txt",
    "node --test test/x.test.mjs &",
    "node --test > out.txt",
    "node --test $(evil)",
    "node --test `evil`",
    "node --test (evil)",
    "cd /tmp && pytest && git commit -am x",
    "cd /tmp && cd /var && pytest",
    "cd /tmp; pytest",
    "cd /tmp && pytest > out.txt",
  ];
  for (const command of rejected) {
    assert.equal(isNarrowVerificationBash(command), false, command);
  }

  assert.equal(isNarrowVerificationBash("cd /tmp && pytest -q"), true);
  assert.equal(
    isNarrowVerificationBash("cd /tmp && timeout 600 pytest -q"),
    true,
  );
});

test("narrow verification allows the focused test and lint commands in use", () => {
  const allowed = [
    "pytest -q",
    "python -m pytest tests/test_app.py",
    "python3 -m mypy src",
    "uv run pytest -q",
    "uv run --project /home/user/Tools/pyenvs/app pytest -q",
    "uv run ruff check .",
    "uv run --project /home/user/Tools/pyenvs/app ruff format --check .",
    "uv run mypy src",
    "ruff check src",
    "ruff format --check src",
    "node --test test/parent-guard.test.mjs",
    "node --check script.mjs",
    "timeout 600 node --test test/x.test.mjs",
    "timeout -s KILL 600 uv run pytest",
    "timeout --signal=TERM 600 python3 -m pytest",
    "npm test",
    "npm run lint",
    "pnpm run typecheck",
    "yarn test",
    "npx vitest run",
    "npx tsc --noEmit",
    "cargo test --all",
    "go test ./...",
    "make test",
    "just test",
  ];
  for (const command of allowed) {
    assert.equal(isNarrowVerificationBash(command), true, command);
  }
});

test("narrow verification rejects installs and mutating verification flags", () => {
  const rejected = [
    "npm install",
    "npm ci",
    "pnpm add left-pad",
    "yarn add left-pad",
    "uv add requests",
    "uv sync",
    "uv pip install requests",
    "uv run python script.py",
    "uv run ruff format .",
    "ruff format .",
    "ruff check --fix",
    "python script.py",
    "python -m pip install requests",
    "python3 -m pytest --fix",
    "node script.js",
    "node -e run",
    "node --eval=run --test",
    "npx tsc",
    "npm run build",
    "npm exec vitest",
    "cargo build",
    "go run ./cmd",
    "make install",
    "sudo pytest",
  ];
  for (const command of rejected) {
    assert.equal(isNarrowVerificationBash(command), false, command);
  }
});

test("post-result exploration budget allows four broad calls then blocks", async () => {
  const branch = workflowBranch("feasibility");
  const budget = { marker: undefined, used: 0 };

  for (let index = 0; index < EXPLORATION_BUDGET_LIMIT; index += 1) {
    assert.equal(
      await evaluateParentToolCall(event("read"), {
        branch,
        explorationBudget: budget,
      }),
      undefined,
    );
  }
  const blocked = await evaluateParentToolCall(event("read"), {
    branch,
    explorationBudget: budget,
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /Start a targeted scout/);

  const newTerminalResult = [
    ...branch,
    subagentResult("second-result", "result", [
      job("feasibility-job", "feasibility", "completed"),
    ]),
  ];
  assert.equal(
    await evaluateParentToolCall(event("grep"), {
      branch: newTerminalResult,
      explorationBudget: budget,
    }),
    undefined,
  );
});

test("parallel post-result exploration consumes distinct budget slots", async () => {
  const branch = workflowBranch("scout");
  const budget = { marker: undefined, used: 0 };

  const results = await Promise.all(
    Array.from({ length: EXPLORATION_BUDGET_LIMIT + 1 }, () =>
      evaluateParentToolCall(event("read"), { branch, explorationBudget: budget }),
    ),
  );
  assert.equal(results.filter((entry) => entry?.block).length, 1);
  assert.equal(budget.used, EXPLORATION_BUDGET_LIMIT + 1);
});

test("narrow verification and plans metadata do not consume the exploration budget", async () => {
  const branch = workflowBranch("feasibility");
  const budget = { marker: undefined, used: 0 };

  for (let index = 0; index < 6; index += 1) {
    assert.equal(
      await evaluateParentToolCall(bashEvent("node --test test/x.test.mjs"), {
        branch,
        explorationBudget: budget,
      }),
      undefined,
    );
  }
  for (let index = 0; index < 6; index += 1) {
    assert.equal(
      await evaluateParentToolCall(
        { toolName: "write", input: { path: "plans/note.md" } },
        { branch, cwd: "/workspace/project", explorationBudget: budget },
      ),
      undefined,
    );
    assert.equal(
      await evaluateParentToolCall(
        { toolName: "read", input: { path: "plans/plan.md" } },
        { branch, cwd: "/workspace/project", explorationBudget: budget },
      ),
      undefined,
    );
  }
  assert.equal(budget.used, 0);

  for (let index = 0; index < EXPLORATION_BUDGET_LIMIT; index += 1) {
    assert.equal(
      await evaluateParentToolCall(event("read"), {
        branch,
        explorationBudget: budget,
      }),
      undefined,
    );
  }
  const blocked = await evaluateParentToolCall(event("read"), {
    branch,
    explorationBudget: budget,
  });
  assert.equal(blocked?.block, true);
});

test("plans metadata stays writable while an active job blocks other tools", async () => {
  const branch = workflowBranch("scout", "running");
  assert.equal(
    await evaluateParentToolCall(
      { toolName: "edit", input: { path: "plans/accepted-plan.md" } },
      { branch, cwd: "/workspace/project" },
    ),
    undefined,
  );
  const blocked = await evaluateParentToolCall(event("edit"), {
    branch,
    cwd: "/workspace/project",
  });
  assert.equal(blocked?.block, true);
});
