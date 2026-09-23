import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const EXTENSION_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const AGENT_ROOT = path.dirname(path.dirname(EXTENSION_ROOT));
const AGENTS_PATH = path.join(AGENT_ROOT, "agents");
const SKILLS_PATH = path.join(AGENT_ROOT, "skills");
const AGENTS_MODULE_PATH = path.join(EXTENSION_ROOT, "agents.ts");

const CHEZMOI_IGNORE_FILENAME = ".chezmoiignore";
const SOURCE_ROOT_ENV_KEYS = ["PI_MULTI_AGENT_SOURCE_ROOT", "CHEZMOI_SOURCE_DIR"];
const MAX_SOURCE_ROOT_ANCESTORS = 8;
const ROUTING_MODULE_PATH = path.join(EXTENSION_ROOT, "routing.mjs");

// Prohibited regression examples, not routing policy: generic workflow
// resources must never hardcode the identifiers of one machine's providers.
const ENVIRONMENT_SPECIFIC_MODEL_IDENTIFIERS = [
  "deepseek/",
  "nowcoding/",
  "gpt-5.6-terra",
];

function isSourceRoot(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, CHEZMOI_IGNORE_FILENAME));
}

function homeCandidates() {
  const homes = [];
  try {
    homes.push(os.userInfo().homedir);
  } catch {
    // Passwd entry may be unavailable (for example in minimal containers).
  }
  homes.push(os.homedir());
  return homes;
}

function sourceRootCandidates() {
  const candidates = [];
  for (const key of SOURCE_ROOT_ENV_KEYS) {
    const value = process.env[key];
    if (value) candidates.push(value);
  }
  let ancestor = EXTENSION_ROOT;
  for (let depth = 0; depth <= MAX_SOURCE_ROOT_ANCESTORS; depth += 1) {
    candidates.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const resolved = spawnSync("chezmoi", ["source-path"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (resolved.status === 0) candidates.push(resolved.stdout.trim());
  const dataHome = process.env.XDG_DATA_HOME;
  for (const home of homeCandidates()) {
    if (dataHome) candidates.push(path.join(dataHome, "chezmoi"));
    candidates.push(path.join(home, ".local", "share", "chezmoi"));
  }
  return [...new Set(candidates)];
}

// The same test runs from the chezmoi source tree and from its applied target
// under ~/.pi/agent, so the source root is discovered instead of derived from
// the test location.
function resolveSourceRoot() {
  const candidates = sourceRootCandidates();
  const root = candidates.find(isSourceRoot);
  assert.ok(
    root,
    `no chezmoi source root containing ${CHEZMOI_IGNORE_FILENAME} among: ${candidates.join(", ")}`,
  );
  return root;
}

function frontmatterLine(filePath, key) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = /^---\n([\s\S]*?)\n---/u.exec(content);
  assert.ok(match, `${filePath} has frontmatter`);
  return match[1].split("\n").find((line) => line.startsWith(`${key}:`));
}

test("source plans are ignored at the repository root", () => {
  const ignorePath = path.join(resolveSourceRoot(), CHEZMOI_IGNORE_FILENAME);
  const patterns = fs.readFileSync(ignorePath, "utf8").split(/\r?\n/u);
  assert.ok(patterns.includes("/plans/"));
});

test("source skills and all four source-managed agents are discoverable", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-ma-resources-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const temporaryAgentDir = path.join(root, "agent");
  await fs.promises.mkdir(temporaryAgentDir);
  await fs.promises.symlink(
    AGENTS_PATH,
    path.join(temporaryAgentDir, "agents"),
    "dir",
  );
  const driver = path.join(root, "resource-driver.ts");
  const output = path.join(root, "resources.json");
  await fs.promises.writeFile(
    driver,
    `
import * as fs from "node:fs";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from ${JSON.stringify(AGENTS_MODULE_PATH)};
const loaded = loadSkillsFromDir({
  dir: ${JSON.stringify(SKILLS_PATH)},
  source: "chezmoi-source",
});
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  skills: loaded.skills.map((skill) => skill.name).sort(),
  diagnostics: loaded.diagnostics,
  agents: discoverAgents().map((agent) => ({
    name: agent.name,
    description: agent.description,
    hasModel: Boolean(agent.model),
  })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
}));
`,
  );
  const result = spawnSync(
    "pi",
    ["--no-extensions", "--extension", driver, "--list-models"],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: temporaryAgentDir,
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const discovered = JSON.parse(await fs.promises.readFile(output, "utf8"));

  assert.ok(discovered.skills.includes("bounded-code-review"));
  assert.ok(discovered.skills.includes("delegated-delivery"));
  assert.deepEqual(
    discovered.agents.map((agent) => agent.name),
    ["feasibility", "implementer", "reviewer", "scout"],
  );
  assert.ok(discovered.agents.every((agent) => agent.description));
  assert.ok(discovered.agents.every((agent) => agent.hasModel === false));

  for (const skill of ["bounded-code-review", "delegated-delivery"]) {
    const line = frontmatterLine(path.join(SKILLS_PATH, skill, "SKILL.md"), "description");
    assert.match(line, /^description: ".*"$/);
  }
  for (const agent of ["scout", "feasibility", "reviewer", "implementer"]) {
    const content = fs.readFileSync(path.join(AGENTS_PATH, `${agent}.md`), "utf8");
    assert.doesNotMatch(content, /^model:/mu);
  }
  const testingDescription = frontmatterLine(
    path.join(SKILLS_PATH, "testing-and-comments", "SKILL.md"),
    "description",
  );
  assert.doesNotMatch(testingDescription, /code review/i);
  assert.match(
    fs.readFileSync(path.join(SKILLS_PATH, "testing-and-comments", "SKILL.md"), "utf8"),
    /bounded-code-review/,
  );
});

test("global AGENTS and delegated-delivery expose the persistent delegation trigger", () => {
  const agents = flatten(
    fs.readFileSync(path.join(AGENT_ROOT, "AGENTS.md"), "utf8"),
  );
  assert.match(agents, /## Delegation/u);
  assert.ok(agents.includes("defaults to orchestrator mode"));
  assert.ok(agents.includes("broad codebase reconnaissance"));
  assert.ok(
    agents.includes("never duplicating broad exploration already delegated"),
  );
  assert.ok(agents.includes("genuinely narrow tasks"));
  assert.ok(
    agents.includes("Load `delegated-delivery` for non-trivial multi-stage work"),
  );
  assert.ok(agents.includes("implementer still needs an approved plan"));

  const skillPath = path.join(SKILLS_PATH, "delegated-delivery", "SKILL.md");
  const description = frontmatterLine(skillPath, "description");
  assert.match(description, /pre-plan investigation/);
  assert.doesNotMatch(description, /after an approved plan/);
  const body = flatten(fs.readFileSync(skillPath, "utf8"));
  assert.doesNotMatch(body, /Use this skill only when/u);
  assert.ok(
    body.includes("Scout and reviewer roles may start before plan approval"),
  );
  assert.ok(body.includes("implementer tasks require an approved plan"));
});

function flatten(text) {
  return text.replace(/\s+/gu, " ");
}

function collectNonTestSources(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "test") {
        collectNonTestSources(path.join(dir, entry.name), files);
      }
    } else if (/\.(?:mjs|ts)$/u.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

test("generic workflow resources keep model routing provider-agnostic", () => {
  const sourceRoot = resolveSourceRoot();
  const files = [
    path.join(AGENT_ROOT, "AGENTS.md"),
    path.join(SKILLS_PATH, "delegated-delivery", "SKILL.md"),
    ...["scout", "feasibility", "reviewer", "implementer"].map((agent) =>
      path.join(AGENTS_PATH, `${agent}.md`),
    ),
    ...collectNonTestSources(EXTENSION_ROOT),
    path.join(sourceRoot, "plans", "plan-workflow-resources.md"),
    path.join(sourceRoot, "plans", "plan-multi-agent-runtime.md"),
  ];
  assert.ok(files.includes(ROUTING_MODULE_PATH));
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(
      content,
      /^\s*(?:model|provider)\s*:\s*["'][^"']+["']/mu,
      `${filePath} must not contain a static model route`,
    );
    for (const identifier of ENVIRONMENT_SPECIFIC_MODEL_IDENTIFIERS) {
      assert.ok(
        !content.includes(identifier),
        `${filePath} must not contain environment-specific identifier ${identifier}`,
      );
    }
  }
});
