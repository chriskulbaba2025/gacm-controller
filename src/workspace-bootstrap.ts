import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceAuthority {
  runId: string;
  trancheId: string;
  repositoryRole: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  expectedRemote: string;
  authoritativeRef: string;
  authoritativeSha: string;
  executionRoot: string;
}

export interface WorkspaceBinding {
  version: 2;
  runId: string;
  trancheId: string;
  repositoryRole: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  expectedRemote: string;
  authoritativeRef: string;
  authoritativeSha: string;
  workspacePath: string;
  executionBranch: string | null;
  createdAt: string;
}

export interface WorkspaceResult {
  binding: WorkspaceBinding;
  topLevel: string;
  remote: string;
  sha: string;
  branch: string;
  dirty: boolean;
  created: boolean;
  currentness: "EXACT";
  repositoryIdentity: string;
}

export type WorkspaceGit = (cwd: string, args: string[]) => Promise<string>;

const BINDING_SUFFIX = ".prysm-gacm-workspace.json";

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").replace(/[\\]+$/g, "").toLowerCase();
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function canonicalRepositoryIdentity(remote: string): string {
  return normalizeRemote(remote);
}

function safeRunLabel(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!safe) throw new Error("Workspace run identity is empty.");
  return safe;
}

function assertBinding(binding: WorkspaceBinding, authority: WorkspaceAuthority, workspacePath: string): void {
  const same = binding.version === 2 &&
    binding.runId === authority.runId &&
    binding.trancheId === authority.trancheId &&
    binding.repositoryRole === authority.repositoryRole &&
    normalizePath(binding.repositoryRoot) === normalizePath(authority.repositoryRoot) &&
    canonicalRepositoryIdentity(binding.repositoryIdentity) === canonicalRepositoryIdentity(authority.repositoryIdentity) &&
    normalizeRemote(binding.expectedRemote) === normalizeRemote(authority.expectedRemote) &&
    binding.authoritativeRef === authority.authoritativeRef &&
    binding.authoritativeSha === authority.authoritativeSha &&
    typeof binding.executionBranch === "string" && binding.executionBranch.length > 0 &&
    normalizePath(binding.workspacePath) === normalizePath(workspacePath);
  if (!same) throw new Error("Execution workspace binding does not match the authorized run identity.");
}

async function pathExists(value: string): Promise<boolean> {
  try { await stat(value); return true; } catch { return false; }
}

async function readBinding(workspacePath: string): Promise<WorkspaceBinding | null> {
  try {
    return JSON.parse(await readFile(workspaceBindingPath(workspacePath), "utf8")) as WorkspaceBinding;
  } catch {
    return null;
  }
}

async function validateExactWorkspace(
  git: WorkspaceGit,
  authority: WorkspaceAuthority,
  workspacePath: string,
  binding: WorkspaceBinding
): Promise<WorkspaceResult> {
  assertBinding(binding, authority, workspacePath);
  const [topLevel, remote, commonDir, sha, branch, porcelain] = await Promise.all([
    git(workspacePath, ["rev-parse", "--show-toplevel"]),
    git(workspacePath, ["remote", "get-url", "origin"]),
    git(workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(workspacePath, ["rev-parse", "HEAD"]),
    git(workspacePath, ["branch", "--show-current"]),
    git(workspacePath, ["status", "--porcelain=v1"])
  ]);
  if (normalizeRemote(remote) !== normalizeRemote(authority.expectedRemote) ||
      canonicalRepositoryIdentity(remote) !== canonicalRepositoryIdentity(authority.repositoryIdentity)) {
    throw new Error("Execution workspace remote identity does not match the authorized repository.");
  }
  const authorizedCommonDir = await git(authority.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (normalizePath(commonDir) !== normalizePath(authorizedCommonDir)) {
    throw new Error("Execution workspace Git common directory does not match the authorized repository.");
  }
  if (sha !== authority.authoritativeSha) {
    throw new Error(`Execution workspace HEAD ${sha} is not authorized SHA ${authority.authoritativeSha}.`);
  }
  if (porcelain.trim()) {
    throw new Error("Execution workspace is dirty; refusing to reset, clean, stash, or overwrite it.");
  }
  if ((branch || null) !== binding.executionBranch) {
    throw new Error("Execution workspace branch/worktree identity changed; resume is blocked.");
  }
  if (normalizePath(topLevel) !== normalizePath(workspacePath)) {
    throw new Error("Execution workspace top-level identity is not the selected workspace path.");
  }
  return { binding, topLevel, remote, sha, branch, dirty: false, created: false, currentness: "EXACT", repositoryIdentity: canonicalRepositoryIdentity(remote) };
}

export async function reconcileExecutionWorkspace(
  authority: WorkspaceAuthority,
  git: WorkspaceGit
): Promise<WorkspaceResult> {
  const [sourceTopLevel, sourceRemote] = await Promise.all([
    git(authority.repositoryRoot, ["rev-parse", "--show-toplevel"]),
    git(authority.repositoryRoot, ["remote", "get-url", "origin"])
  ]);
  if (normalizePath(sourceTopLevel) !== normalizePath(authority.repositoryRoot)) {
    throw new Error("Authorized repository root identity failed before workspace bootstrap.");
  }
  if (normalizeRemote(sourceRemote) !== normalizeRemote(authority.expectedRemote)) {
    throw new Error("Authorized repository remote identity failed before workspace bootstrap.");
  }
  if (canonicalRepositoryIdentity(sourceRemote) !== canonicalRepositoryIdentity(authority.repositoryIdentity)) {
    throw new Error("Authorized repository canonical identity failed before workspace bootstrap.");
  }

  const remoteHead = await git(authority.repositoryRoot, [
    "ls-remote", "origin", `refs/heads/${authority.authoritativeRef}`
  ]);
  const remoteSha = remoteHead.split(/\s+/)[0] || "";
  if (remoteSha !== authority.authoritativeSha) {
    throw new Error(`Authorized remote ref ${authority.authoritativeRef} does not resolve to the authorized SHA.`);
  }
  try {
    await git(authority.repositoryRoot, ["cat-file", "-e", `${authority.authoritativeSha}^{commit}`]);
  } catch {
    await git(authority.repositoryRoot, [
      "fetch", "--no-tags", "origin",
      `refs/heads/${authority.authoritativeRef}:refs/remotes/origin/${authority.authoritativeRef}`
    ]);
    await git(authority.repositoryRoot, ["cat-file", "-e", `${authority.authoritativeSha}^{commit}`]);
  }

  const base = path.resolve(authority.executionRoot);
  await mkdir(base, { recursive: true });
  let workspacePath = path.join(base, safeRunLabel(authority.runId));
  let suffix = 1;
  while (await pathExists(workspacePath)) {
    const existingBinding = await readBinding(workspacePath);
    if (existingBinding) {
      try { return await validateExactWorkspace(git, authority, workspacePath, existingBinding); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("dirty")) throw error;
        if (message.includes("HEAD ")) {
          const existingSha = await git(workspacePath, ["rev-parse", "HEAD"]);
          try {
            await git(workspacePath, ["merge-base", "--is-ancestor", existingSha, authority.authoritativeSha]);
          } catch {
            throw new Error("Existing execution workspace history diverges from the authorized lineage; human decision required.");
          }
        } else if (message.includes("binding") || message.includes("identity") || message.includes("common directory") || message.includes("top-level")) {
          // The old workspace is not reused. It remains untouched while a fresh
          // exact workspace is created below.
        } else {
          throw error;
        }
      }
    }
    workspacePath = path.join(base, `${safeRunLabel(authority.runId)}-${suffix++}`);
  }

  const executionBranch = `governed/${safeRunLabel(authority.repositoryRole)}-${safeRunLabel(authority.runId)}`;
  let branch = executionBranch;
  let branchSuffix = 1;
  while (true) {
    try {
      await git(authority.repositoryRoot, ["worktree", "add", "-b", branch, workspacePath, authority.authoritativeSha]);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|duplicate branch|is already checked out/i.test(message)) throw error;
      branch = `${executionBranch}-${branchSuffix++}`;
    }
  }
  const binding: WorkspaceBinding = {
    version: 2,
    runId: authority.runId,
    trancheId: authority.trancheId,
    repositoryRole: authority.repositoryRole,
    repositoryRoot: authority.repositoryRoot,
    repositoryIdentity: canonicalRepositoryIdentity(authority.repositoryIdentity),
    expectedRemote: authority.expectedRemote,
    authoritativeRef: authority.authoritativeRef,
    authoritativeSha: authority.authoritativeSha,
    workspacePath,
    executionBranch: branch,
    createdAt: new Date().toISOString()
  };
  await writeFile(workspaceBindingPath(workspacePath), JSON.stringify(binding, null, 2) + "\n", "utf8");
  const result = await validateExactWorkspace(git, authority, workspacePath, binding);
  return { ...result, created: true };
}

export async function validatePersistedWorkspaceBinding(
  binding: WorkspaceBinding,
  authority: WorkspaceAuthority,
  git: WorkspaceGit
): Promise<WorkspaceResult> {
  assertBinding(binding, authority, binding.workspacePath);
  return validateExactWorkspace(git, authority, binding.workspacePath, binding);
}

export function workspaceBindingPath(workspacePath: string): string {
  return `${workspacePath}${BINDING_SUFFIX}`;
}

export async function verifyExecutionWorkspaceForLaunch(
  binding: WorkspaceBinding,
  authority: WorkspaceAuthority,
  git: WorkspaceGit
): Promise<WorkspaceResult> {
  const result = await validatePersistedWorkspaceBinding(binding, authority, git);
  if (result.binding.workspacePath !== binding.workspacePath || result.sha !== authority.authoritativeSha) {
    throw new Error("Final executor workspace identity verification failed.");
  }
  return result;
}
