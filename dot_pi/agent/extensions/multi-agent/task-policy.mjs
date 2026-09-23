const GIT_COMMAND =
  /\bgit\b(?:(?:\s+(?:-C|--git-dir|--work-tree|-c|--config-env)(?:=|\s+)\S+)|(?:\s+--?[A-Za-z][A-Za-z0-9-]*(?:=\S+)?))*\s+(add|commit|push|rebase|reset)\b/i;

const ENGLISH_MUTATIONS = [
  ["stage", /\b(?:stage|staging)\s+(?:all\s+|the\s+|these\s+)?(?:changes?|files?|code)\b/i],
  ["commit", /\b(?:stage|staging)\s+and\s+commit\b/i],
  ["commit", /\b(?:create|make|perform|run|execute)\s+(?:a\s+)?(?:signed\s+)?commit\b/i],
  ["commit", /\b(?:sign|signed)\s+(?:a\s+)?commit\b/i],
  ["commit", /\bcommit\s+(?:the\s+|these\s+|all\s+)?(?:changes?|files?|code|repository|repo)\b/i],
  ["push", /\b(?:git\s+)?push\s+(?:to\s+)?(?:origin|remote|repository|repo|branch)\b/i],
  ["rebase", /\b(?:git\s+)?rebase\s+(?:the\s+)?(?:branch|onto|origin|main|master|head)\b/i],
  ["reset", /\b(?:git\s+)?reset\s+(?:the\s+)?(?:branch|repository|repo|head)\b/i],
];

const CHINESE_MUTATIONS = [
  ["stage", /(?:暂存(?:代码|文件|改动|更改|变更)|(?:代码|文件|改动|更改|变更).{0,6}暂存|加入暂存区)/u],
  ["commit", /(?:签名提交|签署提交)/u],
  ["commit", /(?:请|需要|必须|应当|帮我|执行|运行|然后|完成后)\s*提交(?!\s*(?:报告|申请|表单|事务|数据库))/u],
  ["commit", /提交\s*(?:代码|文件|改动|更改|变更|版本|git)/iu],
  ["push", /推送\s*(?:到\s*)?(?:远程|仓库|分支|origin|git)/iu],
  ["rebase", /(?:git|Git|分支).{0,12}变基|变基.{0,12}(?:git|Git|分支)/u],
  ["reset", /(?:git|Git|分支|HEAD).{0,12}重置|重置.{0,12}(?:git|Git|分支|HEAD)/u],
];

const ENGLISH_NEGATION =
  /\b(?:do(?:es)?\s+not|do(?:es)?n['\u2019]t|never|must\s+not|should\s+not|shall\s+not|will\s+not|won['\u2019]t|cannot|can['\u2019]t|forbid(?:den)?|prohibit(?:ed|ion)?|disallow(?:ed)?|not\s+(?:allowed|permitted)|avoid)\b/i;
const CHINESE_NEGATION = /(?:不要|别|不得|禁止|不应|不能|不可|勿|严禁|无需|不需要|不用)/u;
const POLICY_CONTEXT =
  /\b(?:polic(?:y|ies)|rules?|constraints?|guard|instruction|documentation|docs?|example|e\.g\.|for\s+example|quoted?|forbidden|blocked|discuss|describe|explain|mention|reference)\b|(?:策略|规则|约束|守卫|说明|文档|示例|例如|引用|禁止|阻止|讨论|描述|解释|提及)/iu;
const DATABASE_CONTEXT =
  /\b(?:database|db|sql|transaction|persistence|unit\s+of\s+work)\b|(?:数据库|事务|持久化)/iu;
const MULTILINE_CONSTRAINT_CONTEXT =
  /\b(?:following|below|listed?|list|these|those|them|commands?|rules?|constraints?|examples?|items?|mutations?|operations?|actions?)\b|(?:以下|如下|命令|操作|列表|示例|指令|暂存|提交|推送|变基|重置)/iu;
const MAX_CONSTRAINT_LOOKBEHIND_LINES = 4;

function sentenceAround(text, index) {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const start = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf(";"),
    before.lastIndexOf("\n"),
    before.lastIndexOf("。"),
    before.lastIndexOf("！"),
    before.lastIndexOf("？"),
  );
  const ends = [
    after.indexOf("."),
    after.indexOf("!"),
    after.indexOf("?"),
    after.indexOf(";"),
    after.indexOf("\n"),
    after.indexOf("。"),
    after.indexOf("！"),
    after.indexOf("？"),
  ].filter((value) => value >= 0);
  const end = ends.length ? index + Math.min(...ends) : text.length;
  return { text: text.slice(start + 1, end), index: index - start - 1 };
}

function lineAround(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endIndex = text.indexOf("\n", index);
  const end = endIndex === -1 ? text.length : endIndex;
  return { text: text.slice(start, end), start };
}

function previousLine(text, lineStart) {
  if (lineStart <= 0) return undefined;
  const end = lineStart - 1;
  const start = end <= 0 ? 0 : text.lastIndexOf("\n", end - 1) + 1;
  return { text: text.slice(start, end), start };
}

// Anchored variant used to continue a lookbehind over command lists: a bare
// line must be an actual supported mutation invocation, not merely start with
// the word "git" (for example "Git mutation rules:").
const BARE_GIT_COMMAND = new RegExp(`^${GIT_COMMAND.source}`, "i");

function isBareGitCommandLine(line) {
  const withoutMarker = line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  const withoutCodeTicks = withoutMarker.replace(/^`+|`+$/g, "").trim();
  return BARE_GIT_COMMAND.test(withoutCodeTicks);
}

function isConstraintHeading(line) {
  if (POLICY_CONTEXT.test(line) && /[:：]\s*$/.test(line)) return true;
  return (
    (ENGLISH_NEGATION.test(line) || CHINESE_NEGATION.test(line)) &&
    MULTILINE_CONSTRAINT_CONTEXT.test(line)
  );
}

function isScopedByPrecedingConstraint(text, index) {
  let current = lineAround(text, index);
  if (!isBareGitCommandLine(current.text)) return false;

  for (let count = 0; count < MAX_CONSTRAINT_LOOKBEHIND_LINES; count += 1) {
    const preceding = previousLine(text, current.start);
    if (!preceding) return false;
    const line = preceding.text.trim();
    if (!line) return false;
    if (isConstraintHeading(line)) return true;
    if (!isBareGitCommandLine(line) && !/^```/.test(line)) return false;
    current = preceding;
  }
  return false;
}

function isQuotedAt(text, index) {
  for (const quote of ["`", '"', "'"]) {
    const before = text.slice(0, index).split(quote).length - 1;
    const after = text.slice(index).split(quote).length - 1;
    if (before % 2 === 1 && after >= 1) return true;
  }
  return false;
}

function isSuppressed(text, index, action) {
  const sentence = sentenceAround(text, index);
  if (ENGLISH_NEGATION.test(sentence.text) || CHINESE_NEGATION.test(sentence.text)) {
    return true;
  }
  if (POLICY_CONTEXT.test(sentence.text)) return true;
  if (action === "commit" && DATABASE_CONTEXT.test(sentence.text)) return true;
  if (isScopedByPrecedingConstraint(text, index)) return true;
  return isQuotedAt(sentence.text, sentence.index) && POLICY_CONTEXT.test(sentence.text);
}

function firstMatch(text, action, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(matches)) {
    if (isSuppressed(text, match.index, action)) continue;
    return { action, text: match[0] };
  }
  return undefined;
}

/**
 * Find a clearly affirmative Git mutation request in an implementer task.
 *
 * The detector intentionally favors false negatives over rejecting general prose:
 * runtime child guards remain the second enforcement layer for actual commands.
 */
export function findImplementerGitMutation(task) {
  if (typeof task !== "string" || !task.trim()) return undefined;

  const direct = firstMatch(task, "git", GIT_COMMAND);
  if (direct) return direct;
  for (const [action, pattern] of ENGLISH_MUTATIONS) {
    const match = firstMatch(task, action, pattern);
    if (match) return match;
  }
  for (const [action, pattern] of CHINESE_MUTATIONS) {
    const match = firstMatch(task, action, pattern);
    if (match) return match;
  }
  return undefined;
}

/** Reject task-level Git mutation requests before workspace or lease acquisition. */
export function assertImplementerTaskSafe(task) {
  const mutation = findImplementerGitMutation(task);
  if (!mutation) return;
  throw new Error(
    `Implementer tasks cannot request Git mutation (${mutation.text}). The parent session must perform Git staging, commits, pushes, rebases, and resets.`,
  );
}
