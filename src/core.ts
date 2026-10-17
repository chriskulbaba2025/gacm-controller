import { spawn, execFile as execFileCb, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import {
  CODEX_CLI_JS,
  CODEX_MODEL,
  PROJECTS,
  WEBHOOK_URL,
  projectConfig,
  safeProjectPath,
  type ProjectKey
} from "./config.js";
import {
  GACM_REPOSITORIES,
  type GacmRepositoryRole
} from "./config.js";
import {
  repositoryForRole,
  resolveGacmWorkRole,
  type GacmAuthorityResolution
} from "./gacm-authority.js";
import {
  reconcileExecutionWorkspace,
  validatePersistedWorkspaceBinding,
  verifyExecutionWorkspaceForLaunch,
  type WorkspaceAuthority,
  type WorkspaceBinding
} from "./workspace-bootstrap.js";
import {
  CONTROLLER_REPOSITORY_REMOTE,
  assertReadableRunStatus,
  persistRunStatus,
  readPersistedRunStatus,
  type ControllerSourceIdentity,
  type ProductAcceptance,
  type StatusAuthorityContext,
  type TerminalEvidence
} from "./status-contract.js";

import { evaluateProgressGate, parseProgressEvent, type StopReason } from "./progress-guard.js";

const execFile = promisify(execFileCb);
const activeProcesses = new Map<string, ChildProcess>();
const cancelledRuns = new Set<string>();
let activeRunId: string | null = null;

export type RunState = "RUNNING" | "COMPLETE" | "BLOCKED" | "FAILED" | "CANCELLED";

export function classifyGovernedResult(
  exitCode: number | null,
  cancelled: boolean,
  finalText: string,
  proofExists: boolean
): RunState {
  if (cancelled) return "CANCELLED";
  if (exitCode !== 0) return "FAILED";

  const match = finalText.match(/(?:^|\r?\n)RESULT:\s*(?:\r?\n)?\s*([^\r\n]+)/i);
  if (!match) return "BLOCKED";

  const resultLine = match[1].trim().toUpperCase();

  if (/^(BLOCKED|HOLD|WAITING)\b/.test(resultLine)) return "BLOCKED";
  if (/^(FAIL|FAILED|ERROR)\b/.test(resultLine)) return "FAILED";

  if (/^(PASS|PASSED|COMPLETE|COMPLETED|DONE)\b/.test(resultLine)) {
    return proofExists ? "COMPLETE" : "BLOCKED";
  }

  return "BLOCKED";
}

function compactAlert(value: string, max = 1200): string {
  const cleaned = value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + "\n…[truncated]";
}

function extractGovernedSection(
  text: string,
  heading:
    | "RESULT"
    | "BLOCKER"
    | "NEXT ACTION"
    | "ACTION REQUIRED"
    | "CONTROL BOT COMMAND"
): string {
  const match = text.match(
    new RegExp(
      `(?:^|\\n)${heading.replace(/ /g, "\\s+")}:\\s*\\n?([\\s\\S]*?)(?=\\n(?:RESULT|BLOCKER|NEXT\\s+ACTION|ACTION\\s+REQUIRED|CONTROL\\s+BOT\\s+COMMAND):|$)`,
      "i"
    )
  );
  return match?.[1]?.trim() ?? "";
}

function extractProofNextAction(proofText: string): string {
  const match = proofText.match(
    /(?:^|\n)##\s+Safest exact next action\s*\n([\s\S]*?)(?=\n##\s+|$)/i
  );
  return match?.[1]?.trim() ?? "";
}

export function buildOperatorAlert(
  state: RunState,
  project: ProjectKey,
  runId: string,
  finalText: string,
  proofText: string,
  proofDir: string
): {
  message: string;
  result: string;
  blocker: string;
  nextAction: string;
  suggestedMessage: string;
} {
  const result =
    extractGovernedSection(finalText, "RESULT") ||
    (state === "COMPLETE"
      ? "Governed run completed."
      : state === "FAILED"
        ? "Governed run failed."
        : state === "BLOCKED"
          ? "Governed run is blocked."
          : `Governed run ended with state ${state}.`);

  const blocker =
    extractGovernedSection(finalText, "BLOCKER") ||
    (state === "COMPLETE" ? "None stated." : "See proof for blocker details.");

  const nextAction =
    extractProofNextAction(proofText) ||
    extractGovernedSection(finalText, "NEXT ACTION") ||
    (state === "COMPLETE"
      ? "Review the proof and choose the next governed tranche before making another change."
      : "Ask the control bot for details before starting another governed action.");

  const suggestedMessage =
    `${project.toUpperCase()}: ${nextAction.replace(/\s+/g, " ").trim()}`;

  const message = [
    `Run: ${runId}`,
    `Result: ${state}`,
    "",
    "WHAT HAPPENED:",
    compactAlert(result, 900),
    "",
    "BLOCKER:",
    compactAlert(blocker, 700),
    "",
    "SUGGESTED NEXT ACTION:",
    compactAlert(nextAction, 1400),
    "",
    "SEND THIS TO THE CONTROL BOT:",
    compactAlert(suggestedMessage, 1400),
    "",
    `Proof: ${proofDir}`
  ].join("\n");

  return {
    message: compactAlert(message, 3600),
    result,
    blocker,
    nextAction,
    suggestedMessage
  };
}

export interface RepoStatus {
  project: ProjectKey;
  root: string;
  topLevel: string;
  remote: string;
  expectedRemote: string;
  remoteParity: boolean;
  branch: string;
  sha: string;
  dirty: boolean;
  porcelain: string;
  repositoryRole?: GacmRepositoryRole;
  authoritativeRef?: string;
  authoritativeSha?: string;
  acceptedBoundary?: "FOUNDATION_13_ACCEPTED";
  authority?: GacmAuthoritySet;
}

export interface GacmAuthorityStatus {
  role: GacmRepositoryRole;
  root: string;
  expectedRemote: string;
  authoritativeRef: string;
  authoritativeSha: string;
  authoritativeParentSha?: string;
  acceptedBoundary: "FOUNDATION_13_ACCEPTED";
  available: boolean;
  status?: RepoStatus;
  error?: string;
}

export interface GacmAuthoritySet {
  governance: GacmAuthorityStatus;
  application: GacmAuthorityStatus;
  foundation13: "ACCEPTED";
}

export interface RunStatus {
  version: 1;
  controllerSource: ControllerSourceIdentity;
  runId: string;
  project: ProjectKey;
  tranche: string;
  objective: string;
  model: string;
  state: RunState;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  proofDir: string;
  preRunSha: string;
  preRunDirty: boolean;
  repositoryRole?: GacmRepositoryRole;
  authority?: GacmAuthoritySet;
  workspaceAuthority?: WorkspaceAuthority;
  workspaceBinding?: WorkspaceBinding;
  terminalEvidence: TerminalEvidence;
  productAcceptance: ProductAcceptance;
  notification: "PENDING" | "SENT" | "NOT_CONFIGURED" | "FAILED" | "SUPPRESSED";
}

export interface PrysmRunAuthorization {
  branch: string;
  sha: string;
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

async function git(project: ProjectKey, args: string[]): Promise<string> {
  const cfg = projectConfig(project);
  const { stdout } = await execFile("git", ["-C", cfg.root, ...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2_000_000
  });
  return String(stdout).trim();
}

async function gitAtRoot(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2_000_000
  });
  return String(stdout).trim();
}

async function getControllerSourceIdentity(): Promise<ControllerSourceIdentity> {
  const root = process.cwd();
  const [topLevel, remote, branch, sha, porcelain] = await Promise.all([
    gitAtRoot(root, ["rev-parse", "--show-toplevel"]),
    gitAtRoot(root, ["remote", "get-url", "origin"]),
    gitAtRoot(root, ["branch", "--show-current"]),
    gitAtRoot(root, ["rev-parse", "HEAD"]),
    gitAtRoot(root, ["status", "--porcelain=v1"])
  ]);
  if (normalizePath(topLevel) !== normalizePath(root)) {
    throw new Error(`Controller source identity failure: top-level is ${topLevel}, expected ${root}.`);
  }
  if (normalizeRemote(remote) !== normalizeRemote(CONTROLLER_REPOSITORY_REMOTE)) {
    throw new Error(`Controller source identity failure: origin is ${remote}, expected ${CONTROLLER_REPOSITORY_REMOTE}.`);
  }
  if (!branch || !/^[0-9a-f]{40}$/i.test(sha) || porcelain) {
    throw new Error("Controller source identity failure: source must have a named branch, valid HEAD SHA, and clean worktree.");
  }
  return { repositoryRoot: topLevel, repositoryIdentity: remote, branch, sha, clean: true };
}

async function getStatusAuthorityContext(project: ProjectKey): Promise<StatusAuthorityContext> {
  if (project === "gacm") {
    const authority = await getGacmAuthorityStatus();
    const trusted = (role: GacmRepositoryRole) => {
      const selected = authority[role === "GACM_GOVERNANCE" ? "governance" : "application"];
      if (!selected.available || !selected.status) {
        throw new Error(`GACM ${role} authority is unavailable while validating persisted status.`);
      }
      return {
        role,
        repositoryRoot: selected.root,
        expectedRemote: selected.expectedRemote,
        observedRemote: selected.status.remote,
        authoritativeRef: selected.authoritativeRef,
        authoritativeSha: selected.authoritativeSha,
        observedBranch: selected.status.branch,
        observedSha: selected.status.sha
      };
    };
    return {
      gacm: {
        governance: trusted("GACM_GOVERNANCE"),
        application: trusted("GACM_APPLICATION")
      }
    };
  }

  const observed = await getProjectStatus(project);
  return {
    project: {
      role: `${project.toUpperCase()}_PROJECT`,
      repositoryRoot: observed.root,
      expectedRemote: observed.expectedRemote,
      observedRemote: observed.remote,
      authoritativeRef: observed.branch,
      authoritativeSha: observed.sha,
      observedBranch: observed.branch,
      observedSha: observed.sha
    }
  };
}

async function getRepositoryStatus(
  role: GacmRepositoryRole,
  project: ProjectKey = "gacm"
): Promise<RepoStatus> {
  const cfg = GACM_REPOSITORIES[role];
  const [topLevel, remote, branch, sha, porcelain] = await Promise.all([
    gitAtRoot(cfg.root, ["rev-parse", "--show-toplevel"]),
    gitAtRoot(cfg.root, ["remote", "get-url", "origin"]),
    gitAtRoot(cfg.root, ["branch", "--show-current"]),
    gitAtRoot(cfg.root, ["rev-parse", "HEAD"]),
    gitAtRoot(cfg.root, ["status", "--porcelain=v1"])
  ]);
  if (normalizePath(topLevel) !== normalizePath(cfg.root)) {
    throw new Error(`Repo identity failure: top-level is ${topLevel}, expected ${cfg.root}.`);
  }
  const remoteParity = normalizeRemote(remote) === normalizeRemote(cfg.expectedRemote);
  if (!remoteParity) {
    throw new Error(`Repo identity failure: origin is ${remote}, expected ${cfg.expectedRemote}.`);
  }
  return {
    project, root: cfg.root, topLevel, remote, expectedRemote: cfg.expectedRemote,
    remoteParity, branch, sha, dirty: porcelain.length > 0, porcelain,
    repositoryRole: role, authoritativeRef: cfg.authoritativeRef,
    authoritativeSha: cfg.authoritativeSha, acceptedBoundary: cfg.acceptedBoundary
  };
}

async function getGacmRoleStatus(role: GacmRepositoryRole): Promise<GacmAuthorityStatus> {
  const cfg = repositoryForRole(role);
  try {
    const status = await getRepositoryStatus(role);
    await gitAtRoot(cfg.root, ["rev-parse", "--verify", `${cfg.authoritativeRef}^{commit}`]);
    await gitAtRoot(cfg.root, ["rev-parse", "--verify", `${cfg.authoritativeSha}^{commit}`]);
    if (cfg.authoritativeParentSha) {
      await gitAtRoot(cfg.root, ["rev-parse", "--verify", `${cfg.authoritativeParentSha}^{commit}`]);
    }
    return { role, root: cfg.root, expectedRemote: cfg.expectedRemote, authoritativeRef: cfg.authoritativeRef,
      authoritativeSha: cfg.authoritativeSha, authoritativeParentSha: cfg.authoritativeParentSha,
      acceptedBoundary: cfg.acceptedBoundary, available: true, status };
  } catch (error) {
    return { role, root: cfg.root, expectedRemote: cfg.expectedRemote, authoritativeRef: cfg.authoritativeRef,
      authoritativeSha: cfg.authoritativeSha, authoritativeParentSha: cfg.authoritativeParentSha,
      acceptedBoundary: cfg.acceptedBoundary, available: false,
      error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getGacmAuthorityStatus(): Promise<GacmAuthoritySet> {
  const [governance, application] = await Promise.all([
    getGacmRoleStatus("GACM_GOVERNANCE"), getGacmRoleStatus("GACM_APPLICATION")
  ]);
  return { governance, application, foundation13: "ACCEPTED" };
}

export async function getProjectStatus(project: ProjectKey): Promise<RepoStatus> {
  if (project === "gacm") {
    const status = await getRepositoryStatus("GACM_GOVERNANCE");
    return { ...status, project, authority: await getGacmAuthorityStatus() } as RepoStatus & { authority: GacmAuthoritySet };
  }
  const cfg = projectConfig(project);
  const [topLevel, remote, branch, sha, porcelain] = await Promise.all([
    git(project, ["rev-parse", "--show-toplevel"]),
    git(project, ["remote", "get-url", "origin"]),
    git(project, ["branch", "--show-current"]),
    git(project, ["rev-parse", "HEAD"]),
    git(project, ["status", "--porcelain=v1"])
  ]);

  if (normalizePath(topLevel) !== normalizePath(cfg.root)) {
    throw new Error(`Repo identity failure: top-level is ${topLevel}, expected ${cfg.root}.`);
  }

  const remoteParity = normalizeRemote(remote) === normalizeRemote(cfg.expectedRemote);
  if (!remoteParity) {
    throw new Error(`Repo identity failure: origin is ${remote}, expected ${cfg.expectedRemote}.`);
  }

  return {
    project,
    root: cfg.root,
    topLevel,
    remote,
    expectedRemote: cfg.expectedRemote,
    remoteParity,
    branch,
    sha,
    dirty: porcelain.length > 0,
    porcelain
  };
}

export async function readProjectFile(
  project: ProjectKey,
  relativePath: string,
  maxBytes = 200_000
): Promise<{ path: string; bytes: number; content: string }> {
  const absolute = safeProjectPath(project, relativePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Requested path is not a file.");
  if (info.size > maxBytes) {
    throw new Error(`File is ${info.size} bytes; limit is ${maxBytes} bytes.`);
  }
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) throw new Error("Binary files are not supported by this tool.");
  return { path: absolute, bytes: buffer.length, content: buffer.toString("utf8") };
}

export async function getGitDiff(project: ProjectKey, staged = false): Promise<string> {
  await getProjectStatus(project);
  return git(project, staged
    ? ["diff", "--cached", "--no-ext-diff", "--"]
    : ["diff", "--no-ext-diff", "--"]);
}

export async function publishSandboxRun(
  runId: string,
  commitMessage: string
): Promise<{
  runId: string;
  localSha: string;
  remoteSha: string;
  remoteParity: boolean;
  branch: string;
  clean: boolean;
}> {
  if (!runId.startsWith("sandbox-")) {
    throw new Error("Publish is authorized only for sandbox runs.");
  }
  if (!commitMessage || commitMessage.length > 120 || /[\r\n]/.test(commitMessage)) {
    throw new Error("Commit message must be one non-empty line of at most 120 characters.");
  }

  const run = await getCodexStatus(runId);
  if (run.project !== "sandbox" || run.state !== "COMPLETE") {
    throw new Error("Sandbox publish requires a COMPLETE governed sandbox run.");
  }

  const before = await getProjectStatus("sandbox");
  if (before.branch !== "master") {
    throw new Error(`Sandbox publish requires branch master; found ${before.branch || "(detached)"}.`);
  }

  if (before.porcelain.trim() !== "?? TEST-RESULT.txt") {
    throw new Error(
      `Sandbox publish requires exactly one untracked TEST-RESULT.txt change. Found: ${before.porcelain || "(clean)"}`
    );
  }

  const targetPath = safeProjectPath("sandbox", "TEST-RESULT.txt");
  const content = (await readFile(targetPath, "utf8")).replace(/\r\n/g, "\n");
  if (content !== "Governed Telegram control path executed successfully.\n") {
    throw new Error("TEST-RESULT.txt content does not match the authorized S-01 artifact.");
  }

  await git("sandbox", ["add", "--", "TEST-RESULT.txt"]);
  const staged = await git("sandbox", ["diff", "--cached", "--name-only", "--"]);
  if (staged.trim() !== "TEST-RESULT.txt") {
    throw new Error(`Unexpected staged file set: ${staged || "(none)"}`);
  }

  await git("sandbox", ["commit", "-m", commitMessage, "--", "TEST-RESULT.txt"]);
  const localSha = await git("sandbox", ["rev-parse", "HEAD"]);
  await git("sandbox", ["push", "origin", "HEAD:master"]);

  const remoteLine = await git("sandbox", ["ls-remote", "origin", "refs/heads/master"]);
  const remoteSha = remoteLine.split(/\s+/)[0] || "";
  const after = await getProjectStatus("sandbox");
  const remoteParity = Boolean(remoteSha) && remoteSha === localSha;

  if (!remoteParity) {
    throw new Error(`Remote parity failed after push: local ${localSha}, remote ${remoteSha || "(missing)"}.`);
  }
  if (after.dirty) {
    throw new Error(`Sandbox working tree is not clean after publish: ${after.porcelain}`);
  }

  return {
    runId,
    localSha,
    remoteSha,
    remoteParity,
    branch: after.branch,
    clean: !after.dirty
  };
}

function compactTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

function safeLabel(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 60) || "tranche";
}

function runPathFromId(runId: string): { project: ProjectKey; proofDir: string } {
  const project: ProjectKey = runId.startsWith("prysm-")
    ? "prysm"
    : runId.startsWith("gacm-")
      ? "gacm"
      : runId.startsWith("sandbox-")
        ? "sandbox"
        : (() => { throw new Error("Invalid run ID."); })();
  return { project, proofDir: path.join(PROJECTS[project].proofRoot, runId) };
}

async function writeRunStatus(status: RunStatus): Promise<void> {
  const controllerSource = await getControllerSourceIdentity();
  const authority = await getStatusAuthorityContext(status.project);
  await persistRunStatus(path.join(status.proofDir, "status.json"), status, {
    controllerSource,
    runId: status.runId,
    project: status.project,
    proofDir: status.proofDir,
    activeProcess: activeProcesses.has(status.runId),
    authority
  });
}

async function sendWebhook(
  event: string,
  payload: Record<string, unknown>
): Promise<"SENT" | "NOT_CONFIGURED" | "FAILED"> {
  if (!WEBHOOK_URL) return "NOT_CONFIGURED";
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(10_000)
    });
    return response.ok ? "SENT" : "FAILED";
  } catch {
    return "FAILED";
  }
}

export function webhookState(): { configured: boolean; variable: string } {
  return {
    configured: Boolean(WEBHOOK_URL),
    variable: "PRYSM_GACM_N8N_WEBHOOK_URL"
  };
}

export async function sendManualNotification(
  context: string,
  event: "ERROR" | "WAITING_FOR_USER",
  message: string
): Promise<{ state: string; forwardedEvent: "WAITING_FOR_APPROVAL" }> {
  const forwardedEvent = "WAITING_FOR_APPROVAL";
  const state = await sendWebhook(forwardedEvent, {
    project: context,
    sourceEvent: event,
    reason: event === "ERROR" ? "ERROR" : "WAITING_FOR_USER",
    message
  });
  return { state, forwardedEvent };
}

function governedPrompt(
  project: ProjectKey,
  objective: string,
  tranche: string,
  proofDir: string,
  pre: RepoStatus,
  repositoryRole?: GacmRepositoryRole,
  authority?: GacmAuthoritySet
): string {
  return `GOVERNED EXECUTION — ${project.toUpperCase()}

Authorized tranche: ${tranche}
Objective: ${objective}

HARD CONSTRAINTS:
- The controller verifies repository and workspace authority before launch. Do not call prysm_gacm MCP inside this noninteractive Codex child; use local authorized workspace tools.
- Work only inside the exact authorized execution workspace: ${pre.root}
- Authorized repository root: ${authority && repositoryRole ? authority[repositoryRole === "GACM_GOVERNANCE" ? "governance" : "application"].root : pre.root}
- Repository role owning this work: ${repositoryRole || "NOT_APPLICABLE"}
- GACM authority context: ${authority ? JSON.stringify(authority, null, 2) : "NOT_APPLICABLE"}
- Production is read-only. Do not deploy, publish, promote, push, or mutate production.
- Do not git push, git commit, change branches, create branches, or rewrite Git history.
- Do not change model, objective, tranche, repo, or scope.
- Diagnose root cause, owning boundary, related failure modes, and blast radius before editing.
- Preserve unrelated existing changes. The pre-run working tree dirty state is: ${pre.dirty}.
- Maximum three failed repairs in the same defect family; then stop and report the reset requirement.
- Use targeted tests during repair. Do not run broad regression unless the objective explicitly requires it.
- For PRYSM: reach a verifiable source edit or completed targeted check promptly; if no meaningful action is emitted inside the controller early-progress window, it stops the run with BLOCKED, not PASS.
- Missing evidence is not negative evidence. Preserve PASS / FAIL / HOLD and UNKNOWN / PARTIAL / UNAVAILABLE semantics.
- No network-dependent shell actions.
- Write proof to: ${path.join(proofDir, "PROOF.md")}
- Proof must include pre-run SHA, files changed, tests actually run with results, final SHA, remaining blockers, and whether production was untouched.
- Never claim PASS, done, staging-ready, production-ready, or release-ready without the required proof.

PRE-RUN:
branch: ${pre.branch}
sha: ${pre.sha}
dirty:
${pre.porcelain || "(clean)"}

At completion, return exactly these headings:
RESULT:
BLOCKER:
NEXT ACTION:
ACTION REQUIRED:
CONTROL BOT COMMAND:

Rules for the final five headings:
- ACTION REQUIRED must be exactly YES or NO.
- Use YES only when Chris must approve, provide, choose, authorize, or initiate something before governed work can continue.
- Use NO when the run is complete and there is nothing Chris needs to do now.
- If ACTION REQUIRED is YES, CONTROL BOT COMMAND must contain one concrete, copyable instruction Chris can send to the control bot next.
- The CONTROL BOT COMMAND must preserve all relevant safety constraints and exact identifiers needed for the next governed action.
- Do not give vague operator instructions such as "provide a source", "review this", or "decide next steps" when a more concrete governed command can be stated.
- If ACTION REQUIRED is NO, CONTROL BOT COMMAND must be exactly NONE.
`;
}

export function assertAcceptedPrysmRun(authorization: PrysmRunAuthorization | undefined, status: RepoStatus): void {
  const cfg = projectConfig("prysm");
  if (!authorization ||
      authorization.branch !== cfg.authoritativeRef ||
      authorization.sha !== cfg.authoritativeSha) {
    throw new Error("PRYSM run branch/SHA must equal the existing staging accepted authority; no unapproved source pin.");
  }
  if (status.branch !== cfg.authoritativeRef) {
    throw new Error("PRYSM runs require the exact named staging branch, not detached or alternate source.");
  }
  if (normalizeRemote(status.remote) !== normalizeRemote(cfg.expectedRemote)) {
    throw new Error("PRYSM origin does not match the authorized repository.");
  }
  if (status.dirty) {
    throw new Error("PRYSM staging checkout is dirty; no governed run can launch.");
  }
  if (status.sha !== cfg.authoritativeSha) {
    throw new Error("PRYSM staging SHA does not match the accepted authority.");
  }
}

export async function startCodexRun(
  project: ProjectKey,
  objective: string,
  tranche: string,
  gacmRole?: GacmRepositoryRole,
  prysmAuthorization?: PrysmRunAuthorization
): Promise<RunStatus> {
  const controllerSource = await getControllerSourceIdentity();
  if (activeRunId) {
    const current = await getCodexStatus(activeRunId);
    if (current.state === "RUNNING") {
      throw new Error(`A governed Codex run is already active: ${activeRunId}`);
    }
    activeRunId = null;
  }

  let authority: GacmAuthoritySet | undefined;
  let resolvedRole: GacmAuthorityResolution | undefined;
  if (project === "gacm") {
    resolvedRole = resolveGacmWorkRole({ tranche, objective, role: gacmRole });
    authority = await getGacmAuthorityStatus();
    const selected = authority[resolvedRole.role === "GACM_GOVERNANCE" ? "governance" : "application"];
    if (!selected.available || !selected.status) {
      throw new Error(`GACM ${resolvedRole.role} repository is unavailable: ${selected.error || "status unavailable"}`);
    }
  }
  if (project === "prysm") {
    if (!prysmAuthorization || !/^[A-Za-z0-9._/-]+$/.test(prysmAuthorization.branch) || !/^[0-9a-f]{40}$/i.test(prysmAuthorization.sha)) {
      throw new Error("PRYSM runs require an explicit branch and full 40-character commit SHA.");
    }
  }
  const sourcePre = project === "gacm"
    ? (authority![resolvedRole!.role === "GACM_GOVERNANCE" ? "governance" : "application"].status as RepoStatus)
    : await getProjectStatus(project);
  const cfg = projectConfig(project);
  if (project === "prysm") {
    assertAcceptedPrysmRun(prysmAuthorization, sourcePre);
    // An unavailable CLI must fail before workspace or proof side effects.
    await stat(CODEX_CLI_JS);
  }
  const runId = `${project}-${compactTimestamp()}-${safeLabel(tranche)}-${crypto.randomBytes(3).toString("hex")}`;
  const proofDir = path.join(cfg.proofRoot, runId);

  const workspaceAuthority: WorkspaceAuthority = {
    runId,
    trancheId: tranche,
    repositoryRole: resolvedRole?.role || `${project.toUpperCase()}_PROJECT`,
    repositoryRoot: resolvedRole?.repository.root || sourcePre.root,
    repositoryIdentity: resolvedRole?.repository.expectedRemote || sourcePre.expectedRemote,
    expectedRemote: resolvedRole?.repository.expectedRemote || sourcePre.expectedRemote,
    authoritativeRef: resolvedRole?.repository.authoritativeRef || prysmAuthorization?.branch || sourcePre.branch,
    authoritativeSha: resolvedRole?.repository.authoritativeSha || prysmAuthorization?.sha || sourcePre.sha,
    executionRoot: cfg.executionRoot,
    existingWorkspaceOnly: project === "prysm",
    isolatedClone: false
  };
  if (!workspaceAuthority.authoritativeRef) {
    throw new Error("Cannot establish a governed workspace from a detached source without an explicit authority ref.");
  }
  const workspace = await reconcileExecutionWorkspace(workspaceAuthority, gitAtRoot);
  await mkdir(proofDir, { recursive: true });
  const pre: RepoStatus = {
    project,
    root: workspace.binding.workspacePath,
    topLevel: workspace.topLevel,
    remote: workspace.remote,
    expectedRemote: workspaceAuthority.expectedRemote,
    remoteParity: true,
    branch: workspace.branch,
    sha: workspace.sha,
    dirty: workspace.dirty,
    porcelain: "",
    repositoryRole: resolvedRole?.role,
    authoritativeRef: workspaceAuthority.authoritativeRef,
    authoritativeSha: workspaceAuthority.authoritativeSha,
    acceptedBoundary: project === "gacm" ? "FOUNDATION_13_ACCEPTED" : undefined,
    authority
  };

  const status: RunStatus = {
    version: 1,
    controllerSource,
    runId,
    project,
    tranche,
    objective,
    model: CODEX_MODEL,
    state: "RUNNING",
    pid: null,
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    proofDir,
    preRunSha: pre.sha,
    preRunDirty: pre.dirty,
    repositoryRole: resolvedRole?.role,
    authority,
    workspaceAuthority,
    workspaceBinding: workspace.binding,
    terminalEvidence: "NONE",
    productAcceptance: "HOLD",
    notification: WEBHOOK_URL ? "PENDING" : "NOT_CONFIGURED"
  };

  const prompt = governedPrompt(project, objective, tranche, proofDir, pre, resolvedRole?.role, authority);
  await writeFile(path.join(proofDir, "PROMPT.txt"), prompt, "utf8");
  await writeFile(path.join(proofDir, "pre-run-status.json"), JSON.stringify(pre, null, 2) + "\n", "utf8");

  const stdoutPath = path.join(proofDir, "codex-stdout.log");
  const stderrPath = path.join(proofDir, "codex-stderr.log");
  const finalPath = path.join(proofDir, "codex-final.txt");
  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });

  const args = [
    "exec",
    ...(project === "prysm" ? ["--json"] : []),
    "-C", workspace.binding.workspacePath,
    "-m", CODEX_MODEL,
    "--sandbox", "workspace-write",
    "-c", 'windows.sandbox="unelevated"',
    "-c", 'approval_policy="never"',
    "-c", 'mcp_servers.prysm_gacm.enabled=false',
    "-c", "sandbox_workspace_write.network_access=false",
    "--add-dir", proofDir,
    "--output-last-message", finalPath,
    prompt
  ];

  await stat(CODEX_CLI_JS);

  // Final defense-in-depth boundary: authority is revalidated immediately
  // before the child process receives either -C or cwd. No caller-provided
  // directory can substitute for the verified binding here.
  await verifyExecutionWorkspaceForLaunch(workspace.binding, workspaceAuthority, gitAtRoot);

  const child = spawn(process.execPath, [CODEX_CLI_JS, ...args], {
    cwd: workspace.binding.workspacePath,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const launchError = await new Promise<Error | null>((resolve) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve(null);
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      resolve(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  if (launchError) {
    stderrStream.write(`\nPROCESS ERROR: ${String(launchError)}\n`);
    stdoutStream.end();
    stderrStream.end();
    status.state = "FAILED";
    status.finishedAt = new Date().toISOString();
    status.notification = "SUPPRESSED";
    await writeRunStatus(status);
    throw new Error(`Codex launch failed: ${launchError.message}`);
  }

  status.pid = child.pid ?? null;
  activeRunId = runId;
  activeProcesses.set(runId, child);

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  let terminalHandled = false;

  // S2: JSONL telemetry is evidence, not proof of successful code or tests.
  // Apply the early no-result gate to PRYSM only; other project launch paths stay unchanged.
  const progressStarted = Date.now();
  let lastEventAt = progressStarted;
  let firstMeaningfulAt: string | null = null;
  let progressStopReason: StopReason | null = null;
  let tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null = null;
  let progressRemainder = "";
  if (project === "prysm") {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      progressRemainder += String(chunk);
      const records = progressRemainder.split(/\r?\n/);
      progressRemainder = records.pop() || "";
      if (progressRemainder.length > 2_000_000) progressRemainder = ""; // bounded parser memory
      for (const line of records) {
        const observed = parseProgressEvent(line);
        if (observed.activity) lastEventAt = Date.now();
        if (observed.meaningful && firstMeaningfulAt === null) firstMeaningfulAt = new Date().toISOString();
        if (observed.usage) tokenUsage = observed.usage;
      }
    });
  }
  const watchdog = project === "prysm" ? setInterval(() => {
    if (terminalHandled || progressStopReason !== null) return;
    const now = Date.now();
    const stop = evaluateProgressGate(now - progressStarted, now - lastEventAt, firstMeaningfulAt !== null);
    if (!stop) return;
    progressStopReason = stop;
    // This file is controller-authored, separate from Codex proof or terminal evidence.
    void writeFile(path.join(proofDir, "progress-stop.json"), JSON.stringify({
      runId, reason: stop, observedAt: new Date(now).toISOString(),
      firstMeaningfulAt, tokenUsage: tokenUsage || "UNAVAILABLE",
      result: "BLOCKED", source: "GACM_CONTROLLER_S2"
    }, null, 2) + "\n", "utf8").catch(() => undefined);
    if (child.pid) {
      void execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, timeout: 10_000
      }).catch(() => { child.kill(); });
    } else {
      child.kill();
    }
  }, 5_000) : null;

  child.on("error", async (error) => {
    if (terminalHandled) return;
    terminalHandled = true;
    if (watchdog) clearInterval(watchdog);
    stderrStream.write(`\nPROCESS ERROR: ${String(error)}\n`);
    status.state = "FAILED";
    status.finishedAt = new Date().toISOString();
    status.notification = await sendWebhook("WAITING_FOR_APPROVAL", {
      project,
      runId,
      sourceEvent: "ERROR",
      reason: String(error),
      message: `ERROR: Codex run failed. Proof: ${proofDir}`,
      proofDir
    });
    await writeRunStatus(status);
    if (activeRunId === runId) activeRunId = null;
    activeProcesses.delete(runId);
    stdoutStream.end();
    stderrStream.end();
  });

  await writeRunStatus(status);

  child.on("close", async (code) => {
    if (terminalHandled) return;
    terminalHandled = true;
    if (watchdog) clearInterval(watchdog);
    stdoutStream.end();
    stderrStream.end();
    status.exitCode = code;
    status.finishedAt = new Date().toISOString();

    let finalText = "";
    let proofText = "";
    let proofExists = false;
    try {
      finalText = await readFile(finalPath, "utf8");
    } catch {}
    try {
      const proofPath = path.join(proofDir, "PROOF.md");
      const proofInfo = await stat(proofPath);
      proofExists = proofInfo.isFile();
      if (proofExists) {
        proofText = await readFile(proofPath, "utf8");
      }
    } catch {}

    if (progressStopReason !== null) {
      finalText = `RESULT: BLOCKED\nBLOCKER: GACM S2 stopped this run: ${progressStopReason}. No verified edit/test progress within the bounded window.\nNEXT ACTION: Inspect progress-stop.json and codex-stdout.log for this exact run; do not retry automatically.\n`;
    }
    status.state = progressStopReason !== null ? "BLOCKED" : classifyGovernedResult(
      code,
      cancelledRuns.has(runId),
      finalText,
      proofExists
    );
    if (project === "prysm") {
      try {
        await writeFile(path.join(proofDir, "progress-summary.json"), JSON.stringify({
          runId, result: status.state, firstMeaningfulAt,
          elapsedMs: Date.now() - progressStarted,
          tokenUsage: tokenUsage || "UNAVAILABLE",
          controllerStop: progressStopReason,
          outputEventsAvailable: lastEventAt > progressStarted,
          source: "GACM_CONTROLLER_S2"
        }, null, 2) + "\n", "utf8");
      } catch { /* Never turn an observed terminal result into PASS because telemetry write failed. */ }
    }
    status.terminalEvidence = proofExists ? "PROOF_PRESENT" : "NONE";

    const operatorAlert = buildOperatorAlert(
      status.state,
      project,
      runId,
      finalText,
      proofText,
      proofDir
    );

    if (status.state === "FAILED") {
      status.notification = await sendWebhook("WAITING_FOR_APPROVAL", {
        project,
        runId,
        sourceEvent: "ERROR",
        exitCode: code,
        reason: `Codex exited with code ${code}`,
        message: operatorAlert.message,
        result: operatorAlert.result,
        blocker: operatorAlert.blocker,
        nextAction: operatorAlert.nextAction,
        suggestedMessage: operatorAlert.suggestedMessage,
        proofDir
      });
    } else if (status.state === "BLOCKED") {
      status.notification = await sendWebhook("WAITING_FOR_APPROVAL", {
        project,
        runId,
        sourceEvent: "WAITING_FOR_USER",
        reason: "BLOCKED",
        message: operatorAlert.message,
        result: operatorAlert.result,
        blocker: operatorAlert.blocker,
        nextAction: operatorAlert.nextAction,
        suggestedMessage: operatorAlert.suggestedMessage,
        proofDir
      });
    } else if (status.state === "COMPLETE") {
      status.notification = await sendWebhook("WAITING_FOR_APPROVAL", {
        project,
        runId,
        sourceEvent: "WAITING_FOR_USER",
        reason: "WAITING_FOR_USER",
        message: operatorAlert.message,
        result: operatorAlert.result,
        blocker: operatorAlert.blocker,
        nextAction: operatorAlert.nextAction,
        suggestedMessage: operatorAlert.suggestedMessage,
        proofDir
      });
    } else {
      status.notification = "SUPPRESSED";
    }
    await writeRunStatus(status);
    if (activeRunId === runId) activeRunId = null;
    activeProcesses.delete(runId);
    cancelledRuns.delete(runId);
  });

  return status;
}

export async function getCodexStatus(runId: string): Promise<RunStatus> {
  const { project, proofDir } = runPathFromId(runId);
  const controllerSource = await getControllerSourceIdentity();
  const authority = await getStatusAuthorityContext(project);
  const status = await readPersistedRunStatus(path.join(proofDir, "status.json"), {
    controllerSource,
    runId,
    project,
    proofDir,
    activeProcess: activeProcesses.has(runId),
    authority
  });
  assertReadableRunStatus(status, activeProcesses.has(runId));
  return status as unknown as RunStatus;
}

export async function validateCodexResume(runId: string): Promise<RunStatus> {
  const status = await getCodexStatus(runId);
  if (!status.workspaceAuthority || !status.workspaceBinding) {
    throw new Error("Cannot resume a governed run without a persisted workspace identity binding.");
  }
  const cfg = projectConfig(status.project);
  let currentAuthority: WorkspaceAuthority;
  if (status.project === "gacm") {
    if (!status.repositoryRole || !GACM_REPOSITORIES[status.repositoryRole]) {
      throw new Error("Cannot resume a GACM run without an explicit repository role.");
    }
    const roleConfig = GACM_REPOSITORIES[status.repositoryRole];
    currentAuthority = {
      runId: status.runId,
      trancheId: status.tranche,
      repositoryRole: status.repositoryRole,
      repositoryRoot: roleConfig.root,
      repositoryIdentity: roleConfig.expectedRemote,
      expectedRemote: roleConfig.expectedRemote,
      authoritativeRef: roleConfig.authoritativeRef,
      authoritativeSha: roleConfig.authoritativeSha,
      executionRoot: cfg.executionRoot
    };
  } else {
    const saved = status.workspaceAuthority;
    if (status.project === "prysm" && (!saved.authoritativeRef || !/^[0-9a-f]{40}$/i.test(saved.authoritativeSha))) {
      throw new Error("Cannot resume a PRYSM run without the persisted explicit branch and full SHA authorization.");
    }
    currentAuthority = {
      runId: status.runId,
      trancheId: status.tranche,
      repositoryRole: `${status.project.toUpperCase()}_PROJECT`,
      repositoryRoot: cfg.root,
      repositoryIdentity: cfg.expectedRemote,
      expectedRemote: cfg.expectedRemote,
      authoritativeRef: saved.authoritativeRef,
      authoritativeSha: saved.authoritativeSha,
      executionRoot: cfg.executionRoot,
      isolatedClone: saved.isolatedClone === true,
      existingWorkspaceOnly: saved.existingWorkspaceOnly === true
    };
  }
  await validatePersistedWorkspaceBinding(status.workspaceBinding, currentAuthority, gitAtRoot);
  return status;
}

export async function getCodexTail(
  runId: string,
  maxChars = 12_000
): Promise<{ status: RunStatus; stdoutTail: string; stderrTail: string; final: string | null }> {
  const status = await getCodexStatus(runId);
  const readTail = async (file: string): Promise<string> => {
    try {
      const value = await readFile(file, "utf8");
      return value.length > maxChars ? value.slice(-maxChars) : value;
    } catch {
      return "";
    }
  };
  const finalPath = path.join(status.proofDir, "codex-final.txt");
  const final = await readTail(finalPath);
  return {
    status,
    stdoutTail: await readTail(path.join(status.proofDir, "codex-stdout.log")),
    stderrTail: await readTail(path.join(status.proofDir, "codex-stderr.log")),
    final: final || null
  };
}

export async function cancelCodexRun(runId: string): Promise<RunStatus> {
  const child = activeProcesses.get(runId);
  const status = await getCodexStatus(runId);
  if (!child || status.state !== "RUNNING" || !status.pid) {
    throw new Error("Run is not active in this MCP server process.");
  }

  cancelledRuns.add(runId);
  try {
    await execFile("taskkill", ["/PID", String(status.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000
    });
  } catch {
    child.kill();
  }
  return getCodexStatus(runId);
}

export function configuredModel(): string {
  return CODEX_MODEL;
}
