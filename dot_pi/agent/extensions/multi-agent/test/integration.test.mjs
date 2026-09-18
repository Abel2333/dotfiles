import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireLease,
  leaseReference,
  procStartToken,
  transferLease,
} from "../lease.mjs";

const EXTENSION_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const INDEX_PATH = path.join(EXTENSION_ROOT, "index.ts");
const JOBS_PATH = path.join(EXTENSION_ROOT, "jobs.ts");
const LEASE_PATH = path.join(EXTENSION_ROOT, "lease.mjs");
const LEASE_SCOPE_PATH = path.join(EXTENSION_ROOT, "lease-scope.mjs");
const RUNNER_PATH = path.join(EXTENSION_ROOT, "runner.ts");
const WORKSPACE_PATH = path.join(EXTENSION_ROOT, "workspace.ts");
const CHILD_GUARD_PATH = path.join(EXTENSION_ROOT, "child-guard.ts");
const SUPERVISOR_PATH = path.join(EXTENSION_ROOT, "supervisor.mjs");

function processRunning(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    return (
      raw
        .slice(end + 2)
        .trim()
        .split(/\s+/)[0] !== "Z"
    );
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  return new Promise((resolve) => child.once("close", resolve));
}

async function runDriver(root, source, env = {}) {
  const driver = path.join(root, `driver-${Date.now()}-${Math.random()}.ts`);
  await fs.promises.writeFile(driver, source);
  const childEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1",
    ...env,
  };
  for (const [name, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[name];
  }
  const result = spawnSync(
    "pi",
    ["--no-extensions", "--extension", driver, "--list-models"],
    {
      env: childEnv,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function fixtureSourceRepository() {
  const candidates = [process.env.PI_MULTI_AGENT_TEST_REPO, EXTENSION_ROOT].filter(
    Boolean,
  );
  const sourcePath = spawnSync("chezmoi", ["source-path"], {
    encoding: "utf8",
  });
  if (sourcePath.status === 0 && sourcePath.stdout.trim()) {
    candidates.push(sourcePath.stdout.trim());
  }
  for (const candidate of candidates) {
    const result = spawnSync(
      "git",
      ["-C", candidate, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error(
    "Integration tests require PI_MULTI_AGENT_TEST_REPO or a Git-backed chezmoi source directory",
  );
}

async function createGitWorktrees(root, count) {
  const worktrees = Array.from({ length: count }, (_, index) =>
    path.join(root, `worktree-${index + 1}`),
  );
  const cloned = spawnSync(
    "git",
    [
      "clone",
      "-q",
      "--no-hardlinks",
      fixtureSourceRepository(),
      worktrees[0],
    ],
    { encoding: "utf8" },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  for (const worktree of worktrees.slice(1)) {
    const result = spawnSync(
      "git",
      [
        "-C",
        worktrees[0],
        "worktree",
        "add",
        "-q",
        "--detach",
        worktree,
        "HEAD",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  return worktrees;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

async function createOrphanFixture(root, name) {
  const agentDir = path.join(root, "agent");
  const id = `${name}-0000-0000-0000-000000000000`;
  const jobDir = path.join(agentDir, "subagent-sessions", id);
  const sessionDir = path.join(jobDir, "sessions");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const marker = path.join(jobDir, "child.pid");
  const now = new Date().toISOString();
  const leases = [
    await acquireLease(path.join(jobDir, "worktree-writer.lock"), {
      name: `worktree-writer:${root}`,
      jobId: id,
    }),
    await acquireLease(path.join(jobDir, "implementer-slot.lock"), {
      name: "implementer-slot:1",
      jobId: id,
    }),
  ];
  await fs.promises.writeFile(
    path.join(jobDir, "job.json"),
    `${JSON.stringify({
      version: 1,
      id,
      agent: "implementer",
      task: name,
      mode: "project",
      model: "test/model",
      state: "queued",
      cwd: root,
      sourceRoot: root,
      jobDir,
      sessionDir,
      createdAt: now,
      updatedAt: now,
      leases: leases.map((lease) => leaseReference(lease)),
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "live.json"),
    `${JSON.stringify({
      jobId: id,
      state: "queued",
      updatedAt: now,
      lastEventAt: now,
      activitySeq: 0,
      activity: "queued",
      usage: emptyUsage(),
    })}\n`,
  );
  await fs.promises.writeFile(
    path.join(jobDir, "launch.json"),
    `${JSON.stringify({
      jobId: id,
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
        "--",
        "--session-id",
        id,
      ],
      cwd: root,
      env: {},
    })}\n`,
  );
  const log = await fs.promises.open(path.join(jobDir, "test.log"), "a");
  const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, jobDir], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  await new Promise((resolve, reject) => {
    supervisor.once("spawn", resolve);
    supervisor.once("error", reject);
  });
  const supervisorStartToken = await waitFor(() =>
    procStartToken(supervisor.pid),
  );
  for (const lease of leases) {
    await transferLease(lease, {
      ownerPid: supervisor.pid,
      ownerStartToken: supervisorStartToken,
      phase: "supervisor",
    });
  }
  await fs.promises.writeFile(
    path.join(jobDir, "process.json"),
    `${JSON.stringify({
      jobId: id,
      supervisorPid: supervisor.pid,
      supervisorStartToken,
      updatedAt: now,
    })}\n`,
  );
  await fs.promises.writeFile(path.join(jobDir, "launch.ready"), "ready\n");
  const processRecord = await waitFor(async () => {
    try {
      const value = JSON.parse(
        await fs.promises.readFile(path.join(jobDir, "process.json"), "utf8"),
      );
      return value.childPid ? value : undefined;
    } catch {
      return undefined;
    }
  });
  await waitFor(() => fs.existsSync(marker));
  process.kill(supervisor.pid, "SIGKILL");
  await waitForProcess(supervisor);
  await log.close();
  return {
    id,
    jobDir,
    processRecord,
    childPid: processRecord.childPid,
    leases,
  };
}

test("Pi-loaded integration boundaries", { concurrency: 1 }, async (t) => {
  await t.test("multi-agent extension module loads under pi", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-load-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    await runDriver(
      root,
      `import ${JSON.stringify(INDEX_PATH)};\nexport default async function() {}`,
    );
  });

  await t.test(
    "workspace lease blocks cleanup until explicitly released",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-workspace-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { prepareWorkspace, cleanupWorkspace, releasePreparedWorkspaceLease } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const workspace=await prepareWorkspace("scratch",${JSON.stringify(root)},"test",undefined,"job-1"); let blocked=false; try { await cleanupWorkspace(workspace.record.id); } catch { blocked=true; } await releasePreparedWorkspaceLease(workspace); const cleaned=await cleanupWorkspace(workspace.record.id); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({blocked,exists:fs.existsSync(cleaned.path)})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.deepEqual(result, { blocked: true, exists: false });
    },
  );

  await t.test(
    "implementer guard permits project writes only inside the assigned root",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-project-guard-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const repo = path.join(root, "repo");
      await fs.promises.mkdir(repo);
      const output = path.join(root, "guard-result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport childGuard from ${JSON.stringify(CHILD_GUARD_PATH)};\nprocess.env.PI_MULTI_AGENT_ROLE="implementer"; process.env.PI_MULTI_AGENT_MODE="project"; process.env.PI_MULTI_AGENT_WRITABLE_ROOT=${JSON.stringify(repo)}; process.env.PI_MULTI_AGENT_RUNTIME_ROOT=${JSON.stringify(path.join(root, "runtime"))}; let writableHandler; childGuard({on(name,value){if(name==="tool_call") writableHandler=value;}}); const ctx={cwd:${JSON.stringify(repo)}}; const inside=await writableHandler({toolName:"write",input:{path:"src/new.ts"}},ctx); const outside=await writableHandler({toolName:"write",input:{path:${JSON.stringify(path.join(root, "outside.ts"))}}},ctx); const git=await writableHandler({toolName:"bash",input:{command:"git add src/new.ts"}},ctx); process.env.PI_MULTI_AGENT_ROLE="scout"; process.env.PI_MULTI_AGENT_MODE="research"; process.env.PI_MULTI_AGENT_WRITABLE_ROOT=""; let readOnlyHandler; childGuard({on(name,value){if(name==="tool_call") readOnlyHandler=value;}}); const scoutWrite=await readOnlyHandler({toolName:"write",input:{path:"src/new.ts"}},ctx); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({insideAllowed:inside===undefined,outsideReason:outside?.reason,gitReason:git?.reason,scoutReason:scoutWrite?.reason}));\nexport default function(){}\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.insideAllowed, true);
      assert.match(result.outsideReason, /outside the assigned workspace/);
      assert.match(result.gitReason, /Mutating Git commands are not allowed/);
      assert.match(result.scoutReason, /scout is read-only/);
    },
  );

  await t.test(
    "project workspace uses the current Git tree and rejects non-repositories",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-project-workspace-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const repo = path.join(root, "repo");
      await fs.promises.mkdir(repo);
      const initialized = spawnSync("git", ["init", "-q", repo], {
        encoding: "utf8",
      });
      assert.equal(initialized.status, 0, initialized.stderr);
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { prepareWorkspace } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const workspace=await prepareWorkspace("project",${JSON.stringify(repo)},"test",undefined,"job-project"); let rejected=false; try { await prepareWorkspace("project",${JSON.stringify(root)},"test"); } catch { rejected=true; } fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({mode:workspace.mode,cwd:workspace.cwd,sourceRoot:workspace.sourceRoot,writableRoot:workspace.writableRoot,hasRecord:Boolean(workspace.record),hasLease:Boolean(workspace.lease),rejected})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.deepEqual(result, {
        mode: "project",
        cwd: repo,
        sourceRoot: repo,
        writableRoot: repo,
        hasRecord: false,
        hasLease: false,
        rejected: true,
      });
    },
  );

  await t.test(
    "linked worktrees share one canonical Git common directory",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-common-dir-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const [repo, linked] = await createGitWorktrees(root, 2);
      const output = path.join(root, "common-dir.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nimport { acquireLease, leaseReference, releaseLease } from ${JSON.stringify(LEASE_PATH)};\nimport { gitMetadataLeasePath } from ${JSON.stringify(LEASE_SCOPE_PATH)};\nimport { cleanupWorkspace, inspectGitState, prepareWorkspace, releasePreparedWorkspaceLease } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const primary=await inspectGitState(${JSON.stringify(repo)}); const linked=await inspectGitState(${JSON.stringify(linked)}); const workspace=await prepareWorkspace("worktree",${JSON.stringify(linked)},"test",undefined,"job-worktree"); const record={...workspace.record}; await releasePreparedWorkspaceLease(workspace); const writer=await acquireImplementerLeases(record.path,"job-implementer",undefined,0); let cleanupBlocked=false; try { await cleanupWorkspace(record.id,{writerWaitMs:0}); } catch { cleanupBlocked=true; } await releaseUnstartedLeases(writer); const metadata=await acquireLease(gitMetadataLeasePath(record.gitCommonDir),{name:"git-metadata:test",waitMs:0}); let metadataBlocked=false; try { await cleanupWorkspace(record.id,{writerWaitMs:0,metadataWaitMs:0}); } catch { metadataBlocked=true; } await releaseLease(leaseReference(metadata)); const cleaned=await cleanupWorkspace(record.id); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({primary,linked,record,cleanupBlocked,metadataBlocked,cleanedExists:fs.existsSync(cleaned.path)})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.notEqual(result.primary.repoRoot, result.linked.repoRoot);
      assert.equal(result.primary.commonDir, result.linked.commonDir);
      assert.equal(
        result.primary.commonDir,
        await fs.promises.realpath(path.join(repo, ".git")),
      );
      assert.equal(result.record.gitCommonDir, result.primary.commonDir);
      assert.equal(result.cleanupBlocked, true);
      assert.equal(result.metadataBlocked, true);
      assert.equal(result.cleanedExists, false);
    },
  );

  await t.test(
    "implementer launch enables writes and parent-mediated approval metadata",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-implementer-launch-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const jobDir = path.join(root, "job");
      const sessionDir = path.join(jobDir, "sessions");
      const output = path.join(root, "launch-result.json");
      const driverResult = await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { prepareAgentLaunch } from ${JSON.stringify(RUNNER_PATH)};\nexport default async function(){ try { const launch=await prepareAgentLaunch({jobId:"job-implementer",jobDir:${JSON.stringify(jobDir)},sessionDir:${JSON.stringify(sessionDir)},config:{name:"implementer",description:"test",systemPrompt:"implement",filePath:"test"},task:{agent:"implementer",task:"apply plan",summary:"Apply plan",workspace:"project"},model:"test/model",workspace:{mode:"project",cwd:${JSON.stringify(root)},sourceRoot:${JSON.stringify(root)},writableRoot:${JSON.stringify(root)}},guardPath:${JSON.stringify(CHILD_GUARD_PATH)}}); const tools=launch.args[launch.args.indexOf("--tools")+1].split(","); const prompt=fs.readFileSync(path.join(${JSON.stringify(jobDir)},"runtime","prompt.md"),"utf8"); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({cwd:launch.cwd,tools,excluded:launch.args[launch.args.indexOf("--exclude-tools")+1],role:launch.env.PI_MULTI_AGENT_ROLE,mode:launch.env.PI_MULTI_AGENT_MODE,writableRoot:launch.env.PI_MULTI_AGENT_WRITABLE_ROOT,approvalDir:launch.env.PI_SECURITY_APPROVAL_DIR,logDir:launch.env.PI_SECURITY_LOG_DIR,prompt})); } catch(error) { fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined})); } }\n`,
      );
      assert.equal(
        fs.existsSync(output),
        true,
        driverResult.stderr || driverResult.stdout,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.error, undefined, result.stack || result.error);
      assert.equal(result.cwd, root);
      assert.ok(result.tools.includes("edit"));
      assert.ok(result.tools.includes("write"));
      assert.equal(result.excluded, "subagent");
      assert.equal(result.role, "implementer");
      assert.equal(result.mode, "project");
      assert.equal(result.writableRoot, root);
      assert.equal(result.approvalDir, path.join(jobDir, "approvals"));
      assert.equal(result.logDir, path.join(jobDir, "security-logs"));
      assert.match(
        result.prompt,
        /modifying the current Git working tree directly/,
      );
    },
  );

  await t.test(
    "a crashed workspace preparation remains registered and recoverable",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-workspace-crash-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "workspace.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { prepareWorkspace } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const workspace=await prepareWorkspace("scratch",${JSON.stringify(root)},"test",undefined,"job-crashed"); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(workspace.record)); }\n`,
      );
      const record = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(fs.existsSync(record.path), true);
      const cleanedOutput = path.join(root, "cleaned.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { cleanupWorkspace } from ${JSON.stringify(WORKSPACE_PATH)};\nexport default async function(){ const record=await cleanupWorkspace(${JSON.stringify(record.id)},{canRecoverLease:async()=>true}); fs.writeFileSync(${JSON.stringify(cleanedOutput)},JSON.stringify({exists:fs.existsSync(record.path)})); }\n`,
      );
      assert.deepEqual(
        JSON.parse(await fs.promises.readFile(cleanedOutput, "utf8")),
        { exists: false },
      );
    },
  );

  await t.test("feasibility lease acquisition is atomic", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-feas-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const output = path.join(root, "result.json");
    await runDriver(
      root,
      `import * as fs from "node:fs";\nimport { acquireFeasibilityLease, releaseUnstartedLease } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const first=await acquireFeasibilityLease("job-1"); let blocked=false; try { await acquireFeasibilityLease("job-2"); } catch { blocked=true; } await releaseUnstartedLease(first); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({blocked})); }\n`,
    );
    assert.deepEqual(JSON.parse(await fs.promises.readFile(output, "utf8")), {
      blocked: true,
    });
  });

  await t.test(
    "legacy project-writer leases block migration and retire atomically",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-legacy-writer-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const [worktree] = await createGitWorktrees(root, 1);
      const output = path.join(root, "legacy.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { acquireImplementerLeases, cleanupJob, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nimport { acquireLease, leaseReference, releaseLease } from ${JSON.stringify(LEASE_PATH)};\nimport { AGENT_DIR, MULTI_AGENT_LEASE_DIR } from ${JSON.stringify(LEASE_SCOPE_PATH)};\nexport default async function(){ const legacyPath=path.join(MULTI_AGENT_LEASE_DIR,"project-writer.lock"); const legacy=await acquireLease(legacyPath,{name:"project-writer",jobId:"legacy",waitMs:0}); let migrationError=""; try { await acquireImplementerLeases(${JSON.stringify(worktree)},"new-job",undefined,0); } catch(error) { migrationError=error instanceof Error?error.message:String(error); } await releaseLease(leaseReference(legacy)); const leases=await acquireImplementerLeases(${JSON.stringify(worktree)},"new-job",undefined,0); const marker=JSON.parse(fs.readFileSync(legacyPath,"utf8")); let legacyBlocked=false; try { await acquireLease(legacyPath,{name:"project-writer",jobId:"old-session",waitMs:0}); } catch(error) { legacyBlocked=/owner identity is unverified/.test(error instanceof Error?error.message:String(error)); } await releaseUnstartedLeases(leases); const aliasAgentDir=path.join(path.dirname(AGENT_DIR),"agent-alias"); fs.symlinkSync(AGENT_DIR,aliasAgentDir,"dir"); const legacyAliasPath=path.join(aliasAgentDir,"multi-agent","leases","project-writer.lock"); const historicalId="legacy-history-0000-0000-000000000000"; const jobDir=path.join(AGENT_DIR,"subagent-sessions",historicalId); const sessionDir=path.join(jobDir,"sessions"); fs.mkdirSync(sessionDir,{recursive:true}); const now=new Date().toISOString(); fs.writeFileSync(path.join(jobDir,"job.json"),JSON.stringify({version:1,id:historicalId,agent:"implementer",task:"legacy",mode:"project",model:"test/model",state:"completed",cwd:${JSON.stringify(worktree)},sourceRoot:${JSON.stringify(worktree)},jobDir,sessionDir,createdAt:now,updatedAt:now,endedAt:now,leases:[{...leaseReference(legacy),path:legacyAliasPath}]})); fs.writeFileSync(path.join(jobDir,"live.json"),JSON.stringify({jobId:historicalId,state:"completed",updatedAt:now,lastEventAt:now,activitySeq:0,activity:"completed",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:0}})); await cleanupJob(historicalId); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({migrationError,marker,legacyBlocked,historicalCleaned:!fs.existsSync(jobDir)})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.match(result.migrationError, /Legacy project writer is still active/);
      assert.equal(result.marker.retiredProjectWriter, true);
      assert.equal(result.marker.ownerPid, 0);
      assert.equal(result.legacyBlocked, true);
      assert.equal(result.historicalCleaned, true);
    },
  );

  await t.test(
    "implementer leases isolate worktrees and enforce the global capacity",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-implementer-leases-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const worktrees = await createGitWorktrees(root, 6);
      const subdirectory = path.join(worktrees[0], "nested");
      await fs.promises.mkdir(subdirectory);
      const alias = path.join(root, "worktree-alias");
      await fs.promises.symlink(worktrees[0], alias, "dir");
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const roots=${JSON.stringify(worktrees)}; const held=[]; const first=await acquireImplementerLeases(roots[0],"job-1",undefined,0); held.push(first); let sameRootBlocked=false; try { await acquireImplementerLeases(roots[0],"same-root",undefined,0); } catch { sameRootBlocked=true; } let subdirectoryBlocked=false; try { await acquireImplementerLeases(${JSON.stringify(subdirectory)},"subdirectory",undefined,0); } catch { subdirectoryBlocked=true; } let aliasBlocked=false; try { await acquireImplementerLeases(${JSON.stringify(alias)},"alias",undefined,0); } catch { aliasBlocked=true; } for(let index=1;index<5;index+=1) held.push(await acquireImplementerLeases(roots[index],\`job-\${index+1}\`,undefined,0)); let sixthBlocked=false; try { await acquireImplementerLeases(roots[5],"job-6",undefined,0); } catch(error) { sixthBlocked=/limit of 5/.test(error instanceof Error?error.message:String(error)); } await releaseUnstartedLeases(held.pop()); const replacement=await acquireImplementerLeases(roots[5],"job-6-retry",undefined,0); const leaseCounts=[first.length,replacement.length]; await releaseUnstartedLeases(replacement); for(const leases of held.reverse()) await releaseUnstartedLeases(leases); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({sameRootBlocked,subdirectoryBlocked,aliasBlocked,sixthBlocked,leaseCounts})); }\n`,
        { PI_MULTI_AGENT_MAX_IMPLEMENTERS: undefined },
      );
      assert.deepEqual(JSON.parse(await fs.promises.readFile(output, "utf8")), {
        sameRootBlocked: true,
        subdirectoryBlocked: true,
        aliasBlocked: true,
        sixthBlocked: true,
        leaseCounts: [2, 2],
      });
    },
  );

  await t.test(
    "implementer leases coordinate across processes and agent-dir aliases",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-cross-process-writer-test-"),
      );
      const realAgentDir = path.join(root, "agent-real");
      const aliasAgentDir = path.join(root, "agent-alias");
      const [firstRoot, secondRoot] = await createGitWorktrees(root, 2);
      await fs.promises.mkdir(realAgentDir);
      await fs.promises.symlink(realAgentDir, aliasAgentDir, "dir");
      const ready = path.join(root, "ready");
      const gate = path.join(root, "release");
      const holderDriver = path.join(root, "holder.ts");
      await fs.promises.writeFile(
        holderDriver,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const leases=await acquireImplementerLeases(${JSON.stringify(firstRoot)},"holder",undefined,0); fs.writeFileSync(${JSON.stringify(ready)},"ready\\n"); while(!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve=>setTimeout(resolve,10)); await releaseUnstartedLeases(leases); }\n`,
      );
      const holder = spawn(
        "pi",
        ["--no-extensions", "--extension", holderDriver, "--list-models"],
        {
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: aliasAgentDir,
            PI_MULTI_AGENT_MAX_IMPLEMENTERS: "5",
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let holderStderr = "";
      holder.stderr.on("data", (chunk) => {
        holderStderr += chunk.toString();
      });
      t.after(async () => {
        await fs.promises.writeFile(gate, "release\n").catch(() => {});
        if (processRunning(holder.pid)) process.kill(holder.pid, "SIGKILL");
        await waitForProcess(holder).catch(() => undefined);
        await fs.promises.rm(root, { recursive: true, force: true });
      });
      await waitFor(() => fs.existsSync(ready));

      const sameRootOutput = path.join(root, "same-root.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ let blocked=false; let leases; try { leases=await acquireImplementerLeases(${JSON.stringify(firstRoot)},"contender",undefined,0); } catch { blocked=true; } if(leases) await releaseUnstartedLeases(leases); fs.writeFileSync(${JSON.stringify(sameRootOutput)},JSON.stringify({blocked})); }\n`,
        {
          PI_CODING_AGENT_DIR: realAgentDir,
          PI_MULTI_AGENT_MAX_IMPLEMENTERS: "5",
        },
      );
      assert.deepEqual(
        JSON.parse(await fs.promises.readFile(sameRootOutput, "utf8")),
        { blocked: true },
      );

      const conflictOutput = path.join(root, "capacity-conflict.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ let error=""; let leases; try { leases=await acquireImplementerLeases(${JSON.stringify(secondRoot)},"conflict",undefined,0); } catch(value) { error=value instanceof Error?value.message:String(value); } if(leases) await releaseUnstartedLeases(leases); fs.writeFileSync(${JSON.stringify(conflictOutput)},JSON.stringify({error})); }\n`,
        {
          PI_CODING_AGENT_DIR: realAgentDir,
          PI_MULTI_AGENT_MAX_IMPLEMENTERS: "6",
        },
      );
      const conflict = JSON.parse(
        await fs.promises.readFile(conflictOutput, "utf8"),
      );
      assert.match(conflict.error, /active capacity is 5.*requested 6/);

      await fs.promises.writeFile(gate, "release\n");
      assert.equal(await waitForProcess(holder), 0, holderStderr);
    },
  );

  await t.test(
    "implementer capacity rejects invalid and conflicting configuration",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-implementer-capacity-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const [firstRoot, secondRoot] = await createGitWorktrees(root, 2);
      const conflictOutput = path.join(root, "conflict.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { acquireImplementerLeases, releaseUnstartedLeases } from ${JSON.stringify(JOBS_PATH)};\nimport { MULTI_AGENT_LEASE_DIR } from ${JSON.stringify(LEASE_SCOPE_PATH)};\nexport default async function(){ const first=await acquireImplementerLeases(${JSON.stringify(firstRoot)},"job-1",undefined,0); process.env.PI_MULTI_AGENT_MAX_IMPLEMENTERS="6"; let conflict=""; try { await acquireImplementerLeases(${JSON.stringify(secondRoot)},"job-2",undefined,0); } catch(error) { conflict=error instanceof Error?error.message:String(error); } await releaseUnstartedLeases(first); const switched=await acquireImplementerLeases(${JSON.stringify(secondRoot)},"job-2-retry",undefined,0); await releaseUnstartedLeases(switched); const stalePath=path.join(MULTI_AGENT_LEASE_DIR,"implementer-slot-1.lock"); fs.writeFileSync(stalePath,JSON.stringify({version:1,name:"implementer-slot:1",token:"stale-token",ownerPid:2000000000,ownerStartToken:"1",jobId:"missing-job",createdAt:new Date().toISOString()})); process.env.PI_MULTI_AGENT_MAX_IMPLEMENTERS="5"; const recovered=await acquireImplementerLeases(${JSON.stringify(firstRoot)},"job-after-stale",undefined,0); const reusedStaleSlot=recovered[1].path===stalePath && recovered[1].token!=="stale-token"; await releaseUnstartedLeases(recovered); fs.writeFileSync(${JSON.stringify(conflictOutput)},JSON.stringify({conflict,switched:switched.length,reusedStaleSlot,staleGone:!fs.existsSync(stalePath)})); }\n`,
        { PI_MULTI_AGENT_MAX_IMPLEMENTERS: "5" },
      );
      const conflict = JSON.parse(
        await fs.promises.readFile(conflictOutput, "utf8"),
      );
      assert.match(conflict.conflict, /active capacity is 5.*requested 6/);
      assert.equal(conflict.switched, 2);
      assert.equal(conflict.reusedStaleSlot, true);
      assert.equal(conflict.staleGone, true);

      const invalidOutput = path.join(root, "invalid.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { acquireImplementerLeases, configuredImplementerLimit } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const invalidValues=["","1.5","1e1","65","9007199254740992"]; const strictErrors=invalidValues.map(value=>{try{configuredImplementerLimit({PI_MULTI_AGENT_MAX_IMPLEMENTERS:value});return false;}catch{return true;}}); let error=""; try { await acquireImplementerLeases(${JSON.stringify(firstRoot)},"invalid",undefined,0); } catch(value) { error=value instanceof Error?value.message:String(value); } fs.writeFileSync(${JSON.stringify(invalidOutput)},JSON.stringify({defaultLimit:configuredImplementerLimit({}),strictErrors,error})); }\n`,
        { PI_MULTI_AGENT_MAX_IMPLEMENTERS: "0" },
      );
      const invalid = JSON.parse(
        await fs.promises.readFile(invalidOutput, "utf8"),
      );
      assert.equal(invalid.defaultLimit, 5);
      assert.deepEqual(invalid.strictErrors, [true, true, true, true, true]);
      assert.match(invalid.error, /PI_MULTI_AGENT_MAX_IMPLEMENTERS/);
    },
  );

  await t.test(
    "queued jobs remain protected while their launcher is still active",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-launching-job-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const output = path.join(root, "launching.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { abortJob, getJobSnapshot } from ${JSON.stringify(JOBS_PATH)};\nimport { acquireLease, leaseReference, procStartToken, releaseLease } from ${JSON.stringify(LEASE_PATH)};\nimport { AGENT_DIR } from ${JSON.stringify(LEASE_SCOPE_PATH)};\nexport default async function(){ const id="launching-0000-0000-0000-000000000000"; const jobDir=path.join(AGENT_DIR,"subagent-sessions",id); const sessionDir=path.join(jobDir,"sessions"); fs.mkdirSync(sessionDir,{recursive:true}); const lease=await acquireLease(path.join(jobDir,"writer.lock"),{name:"worktree-writer:test",jobId:id}); const now=new Date().toISOString(); fs.writeFileSync(path.join(jobDir,"process.json"),JSON.stringify({jobId:id,supervisorPid:process.pid,supervisorStartToken:procStartToken(process.pid),phase:"launching",updatedAt:now})); fs.writeFileSync(path.join(jobDir,"job.json"),JSON.stringify({version:1,id,agent:"implementer",task:"test",mode:"project",model:"test/model",state:"queued",cwd:${JSON.stringify(root)},sourceRoot:${JSON.stringify(root)},jobDir,sessionDir,createdAt:now,updatedAt:now,leases:[leaseReference(lease)]})); fs.writeFileSync(path.join(jobDir,"live.json"),JSON.stringify({jobId:id,state:"queued",updatedAt:now,lastEventAt:now,activitySeq:0,activity:"queued",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:0}})); const snapshot=await getJobSnapshot(id); let abortError=""; try { await abortJob(id); } catch(error) { abortError=error instanceof Error?error.message:String(error); } const leaseProtected=fs.existsSync(lease.path); await releaseLease(leaseReference(lease)); fs.rmSync(jobDir,{recursive:true,force:true}); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({state:snapshot.job.state,processAlive:snapshot.processAlive,leaseProtected,abortError})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.state, "queued");
      assert.equal(result.processAlive, true);
      assert.equal(result.leaseProtected, true);
      assert.match(result.abortError, /while it is launching/);
    },
  );

  await t.test(
    "startJob hands lease bundles to the Supervisor and releases them after spawn failure",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-start-failure-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const [worktree] = await createGitWorktrees(root, 1);
      const output = path.join(root, "result.json");
      const guardPath = path.join(EXTENSION_ROOT, "child-guard.ts");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { acquireFeasibilityLease, acquireImplementerLeases, createJobId, startJob, waitForJob } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const id=createJobId(); const lease=await acquireFeasibilityLease(id); const implementerLeases=await acquireImplementerLeases(${JSON.stringify(worktree)},id,undefined,0); const snapshot=await startJob({id,config:{name:"feasibility",description:"test",systemPrompt:"test",filePath:"test"},task:{agent:"feasibility",task:"test",workspace:"research"},model:"invalid/model",workspace:{mode:"research",cwd:path.join(${JSON.stringify(root)},"missing"),sourceRoot:${JSON.stringify(root)}},feasibilityLease:lease,implementerLeases,guardPath:${JSON.stringify(guardPath)}}); const final=await waitForJob(snapshot.job.id,10); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({state:final.job.state,leaseExists:fs.existsSync(lease.path),implementerLeaseExists:implementerLeases.map(item=>fs.existsSync(item.path))})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.state, "failed");
      assert.equal(result.leaseExists, false);
      assert.deepEqual(result.implementerLeaseExists, [false, false]);
    },
  );

  await t.test("orphan recovery terminates a verified child", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-ma-orphan-test-"),
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const fixture = await createOrphanFixture(root, "orphan");
    t.after(() => {
      if (processRunning(fixture.childPid))
        process.kill(-fixture.childPid, "SIGKILL");
    });
    const output = path.join(root, "result.json");
    await runDriver(
      root,
      `import * as fs from "node:fs";\nimport { getJobSnapshot } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const snapshot=await getJobSnapshot(${JSON.stringify(fixture.id)}); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(snapshot)); }\n`,
    );
    const snapshot = JSON.parse(await fs.promises.readFile(output, "utf8"));
    await waitFor(() => !processRunning(fixture.childPid));
    assert.equal(snapshot.job.state, "orphaned");
    for (const lease of fixture.leases) {
      assert.equal(fs.existsSync(lease.path), false);
    }
  });

  await t.test(
    "unverified child identity is not signalled and blocks cleanup",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-unverified-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const fixture = await createOrphanFixture(root, "unverified");
      t.after(() => {
        if (processRunning(fixture.childPid))
          process.kill(-fixture.childPid, "SIGKILL");
      });
      const processPath = path.join(fixture.jobDir, "process.json");
      const record = JSON.parse(
        await fs.promises.readFile(processPath, "utf8"),
      );
      delete record.childStartToken;
      await fs.promises.writeFile(processPath, `${JSON.stringify(record)}\n`);
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { cleanupJob, getJobSnapshot } from ${JSON.stringify(JOBS_PATH)};\nexport default async function(){ const snapshot=await getJobSnapshot(${JSON.stringify(fixture.id)}); let cleanupBlocked=false; try { await cleanupJob(${JSON.stringify(fixture.id)}); } catch { cleanupBlocked=true; } fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({snapshot,cleanupBlocked})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.equal(result.snapshot.childIdentity, "unverified");
      assert.equal(result.cleanupBlocked, true);
      assert.equal(processRunning(fixture.childPid), true);
      for (const lease of fixture.leases) {
        assert.equal(fs.existsSync(lease.path), true);
      }
    },
  );

  await t.test(
    "large final output is streamed, bounded, and keeps head and tail",
    async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-ma-result-test-"),
      );
      t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
      const agentDir = path.join(root, "agent");
      const id = "result-0000-0000-0000-000000000000";
      const jobDir = path.join(agentDir, "subagent-sessions", id);
      const sessionDir = path.join(jobDir, "sessions");
      await fs.promises.mkdir(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "session.jsonl");
      const now = new Date().toISOString();
      const finalText = `HEAD-${"中🙂".repeat(100000)}-TAIL`;
      await fs.promises.writeFile(
        sessionPath,
        `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "job.json"),
        `${JSON.stringify({ version: 1, id, agent: "scout", task: "result", mode: "research", model: "test/model", state: "completed", cwd: root, sourceRoot: root, jobDir, sessionDir, sessionPath, createdAt: now, updatedAt: now, endedAt: now })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "live.json"),
        `${JSON.stringify({ jobId: id, state: "completed", updatedAt: now, lastEventAt: now, activitySeq: 1000, activity: "completed", usage: emptyUsage() })}\n`,
      );
      await fs.promises.writeFile(
        path.join(jobDir, "activity.jsonl"),
        `${Array.from({ length: 1000 }, (_, index) => JSON.stringify({ seq: index + 1, timestamp: now, type: "test", summary: `event-${index + 1}` })).join("\n")}\n`,
      );
      const output = path.join(root, "result.json");
      await runDriver(
        root,
        `import * as fs from "node:fs";\nimport { getJobResult } from ${JSON.stringify(JOBS_PATH)};\nimport { truncateOutput } from ${JSON.stringify(RUNNER_PATH)};\nexport default async function(){ const result=await getJobResult(${JSON.stringify(id)},0,10); const bounded=truncateOutput(result.finalOutput); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({rawBytes:Buffer.byteLength(result.finalOutput,"utf8"),boundedBytes:Buffer.byteLength(bounded,"utf8"),bounded,hasMessages:Object.hasOwn(result,"messages"),activityCount:result.activities.length,nextCursor:result.nextCursor})); }\n`,
      );
      const result = JSON.parse(await fs.promises.readFile(output, "utf8"));
      assert.ok(result.rawBytes <= 256 * 1024);
      assert.ok(result.boundedBytes <= 128 * 1024);
      assert.match(result.bounded, /^HEAD-/);
      assert.match(result.bounded, /-TAIL$/);
      assert.equal(result.hasMessages, false);
      assert.equal(result.activityCount, 10);
      assert.equal(result.nextCursor, 10);
    },
  );
});
