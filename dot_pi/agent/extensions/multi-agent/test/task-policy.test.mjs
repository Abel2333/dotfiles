import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImplementerTaskSafe,
  findImplementerGitMutation,
} from "../task-policy.mjs";

test("implementer preflight rejects clear affirmative Git mutation requests", () => {
  const cases = [
    ["Run git add src/index.ts before reporting.", "git"],
    ["Run git --no-verify commit -m 'finish'.", "git"],
    ["Use git -C /repo rebase main.", "git"],
    ["Please stage all changes.", "stage"],
    ["Create a signed commit after tests pass.", "commit"],
    ["Commit the changes and push to origin.", "commit"],
    ["请将代码暂存，然后提交代码。", "stage"],
    ["完成后推送到远程仓库。", "push"],
    ["请对分支执行变基。", "rebase"],
  ];

  for (const [task, action] of cases) {
    const mutation = findImplementerGitMutation(task);
    assert.equal(mutation?.action, action, task);
    assert.throws(() => assertImplementerTaskSafe(task), /cannot request Git mutation/);
  }
});

test("implementer preflight ignores negation, policy, examples, and database commits", () => {
  const cases = [
    "Do not commit changes, stage files, or push to origin.",
    "Never run git commit -m 'message'.",
    "不要提交代码，也不得暂存或推送远程仓库。",
    "The policy says git commit is forbidden.",
    "Document the guard rule: git add and git commit are blocked.",
    "For example, `git commit -m message` is prohibited in delegated work.",
    "Explain the Git mutation policy without executing git push.",
    "Commit changes to the database transaction only.",
    "The database commit must remain atomic; do not change Git state.",
    "数据库提交事务，不需要提交代码。",
  ];

  for (const task of cases) {
    assert.equal(findImplementerGitMutation(task), undefined, task);
    assert.doesNotThrow(() => assertImplementerTaskSafe(task), task);
  }
});

test("preflight favors task-level Git requests over unrelated technical prose", () => {
  assert.equal(
    findImplementerGitMutation("Discuss Git history and report the current branch."),
    undefined,
  );
  assert.equal(
    findImplementerGitMutation("Use git diff to inspect the worktree."),
    undefined,
  );
  assert.equal(
    findImplementerGitMutation("Discuss how Git commits work without creating one."),
    undefined,
  );
  assert.equal(
    findImplementerGitMutation("After the implementation is complete, commit changes.")?.action,
    "commit",
  );
});

test("implementer preflight recognizes expanded negation forms and command lists", () => {
  const cases = [
    "The worker does not run git add .",
    "The worker doesn't run git push origin main.",
    "The worker shall not run git commit -m finish.",
    "The worker will not run git reset --hard.",
    "The worker won't run git rebase main.",
    "Git mutations are not permitted: git add .",
    "别运行 git push origin main。",
    `Do not run any of the following:
git add .
git push origin main`,
    `The policy forbids the following commands:
- git add .
- git push origin main`,
  ];

  for (const task of cases) {
    assert.equal(findImplementerGitMutation(task), undefined, task);
    assert.doesNotThrow(() => assertImplementerTaskSafe(task), task);
  }
});

test("multiline constraint headings cover rule and constraint vocabulary", () => {
  const cases = [
    `Constraints:
Do not run any of these:
git add .
git push origin main.`,
    `Git mutation rules:
git push and git commit are out of scope.`,
  ];

  for (const task of cases) {
    assert.equal(findImplementerGitMutation(task), undefined, task);
    assert.doesNotThrow(() => assertImplementerTaskSafe(task), task);
  }
});

test("multiline policy suppression stops before a later affirmative request", () => {
  const cases = [
    `Do not run any of the following:
git add .
After documenting the list, run git push origin main.`,
    `Constraints:
Do not run any of these:
git add .
git push origin main.
When the branch is ready, git commit -m 'finish'.`,
    `Git mutation rules:
git push and git commit are out of scope.
Finally run git push origin main.`,
  ];

  for (const task of cases) {
    const mutation = findImplementerGitMutation(task);
    assert.ok(mutation, task);
    assert.equal(mutation.action, "git", task);
    assert.match(mutation.text, /git (?:push|commit)/i, task);
  }
});
