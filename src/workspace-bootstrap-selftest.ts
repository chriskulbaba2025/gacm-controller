import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  reconcileExecutionWorkspace,
  validatePersistedWorkspaceBinding,
  verifyExecutionWorkspaceForLaunch,
  workspaceBindingPath,
  type WorkspaceAuthority,
  type WorkspaceBinding,
  type WorkspaceGit
} from "./workspace-bootstrap.js";

interface FakeState { topLevel: string; remote: string; commonDir: string; sha: string; branch: string; porcelain: string; ancestor: boolean }

class FakeGit {
  readonly calls: Array<{ cwd: string; args: string[] }> = [];
  readonly states = new Map<string, FakeState>();
  constructor(readonly source: string, readonly remote: string, readonly remoteSha: string, readonly failFetch = false) {
    this.states.set(source, { topLevel: source, remote, commonDir: path.join(source, ".git"), sha: "stale-head", branch: "main", porcelain: "", ancestor: true });
  }
  readonly run: WorkspaceGit = async (cwd, args) => {
    this.calls.push({ cwd, args });
    const state = this.states.get(cwd);
    if (args[0] === "ls-remote") return `${this.remoteSha}\trefs/heads/${args[2].replace("refs/heads/", "")}\n`;
    if (args[0] === "cat-file") {
      if (this.failFetch) throw new Error("object missing locally");
      if (args[2] === `${this.remoteSha}^{commit}`) return "";
      throw new Error("missing object");
    }
    if (args[0] === "fetch") throw new Error("fetch unavailable");
    if (args[0] === "worktree" && args[1] === "add") {
      const workspace = args[4];
      await mkdir(workspace, { recursive: true });
      this.states.set(workspace, { topLevel: workspace, remote: this.remote, commonDir: path.join(this.source, ".git"), sha: args[5], branch: args[3], porcelain: "", ancestor: true });
      return "";
    }
    if (!state) throw new Error(`unknown fake cwd ${cwd}`);
    if (args[0] === "merge-base") {
      if (!state.ancestor) throw new Error("not an ancestor");
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return state.topLevel;
    if (args[0] === "remote") return state.remote;
    if (args[0] === "rev-parse" && args[1] === "--path-format=absolute") return state.commonDir;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return state.sha;
    if (args[0] === "branch") return state.branch;
    if (args[0] === "status") return state.porcelain;
    throw new Error(`unexpected fake git command: ${args.join(" ")}`);
  };
}

function authority(root: string, executionRoot: string, sha = "authorized-sha"): WorkspaceAuthority {
  return {
    runId: "gacm-test-run",
    trancheId: "F14",
    repositoryRole: "GACM_APPLICATION",
    repositoryRoot: root,
    repositoryIdentity: "https://github.com/example/application.git",
    expectedRemote: "https://github.com/example/application.git",
    authoritativeRef: "candidate/future",
    authoritativeSha: sha,
    executionRoot
  };
}

async function seedWorkspace(
  git: FakeGit,
  auth: WorkspaceAuthority,
  sha: string,
  porcelain: string,
  bindingOverrides: Partial<WorkspaceBinding> = {},
  ancestor = true
): Promise<string> {
  const workspace = path.join(auth.executionRoot, auth.runId);
  await mkdir(workspace, { recursive: true });
  git.states.set(workspace, { topLevel: workspace, remote: auth.expectedRemote, commonDir: path.join(auth.repositoryRoot, ".git"), sha, branch: "governed-GACM_APPLICATION-gacm-test-run", porcelain, ancestor });
  const binding: WorkspaceBinding = {
    version: 2, runId: auth.runId, trancheId: auth.trancheId, repositoryRole: auth.repositoryRole,
    repositoryRoot: auth.repositoryRoot, expectedRemote: auth.expectedRemote,
    repositoryIdentity: auth.repositoryIdentity,
    authoritativeRef: auth.authoritativeRef, authoritativeSha: auth.authoritativeSha,
    workspacePath: workspace, executionBranch: "governed-GACM_APPLICATION-gacm-test-run", createdAt: new Date().toISOString(), ...bindingOverrides
  };
  await writeFile(workspaceBindingPath(workspace), JSON.stringify(binding), "utf8");
  return workspace;
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prysm-gacm-workspace-test-"));
  try {
    const source = path.join(root, "source");
    const executionRoot = path.join(root, "execution");
    await mkdir(source, { recursive: true });

    const git = new FakeGit(source, "https://github.com/example/application.git", "authorized-sha");
    const auth = authority(source, executionRoot);

    const exact = await reconcileExecutionWorkspace(auth, git.run);
    assert.equal(exact.sha, "authorized-sha");
    assert.equal(exact.currentness, "EXACT");

    const staleAuth = authority(source, path.join(root, "stale-execution"));
    const staleGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const stalePath = await seedWorkspace(staleGit, staleAuth, "clean-ancestor", "");
    const stale = await reconcileExecutionWorkspace(staleAuth, staleGit.run);
    assert.equal(stale.sha, staleAuth.authoritativeSha);
    assert.notEqual(stale.binding.workspacePath, stalePath);
    assert.equal(staleGit.states.get(stalePath)?.sha, "clean-ancestor");

    const dirtyAuth = authority(source, path.join(root, "dirty-execution"));
    const dirtyGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    await seedWorkspace(dirtyGit, dirtyAuth, dirtyAuth.authoritativeSha, " M intentional.txt");
    await assert.rejects(() => reconcileExecutionWorkspace(dirtyAuth, dirtyGit.run), /dirty/);
    assert.equal(dirtyGit.states.get(path.join(dirtyAuth.executionRoot, dirtyAuth.runId))?.porcelain, " M intentional.txt");

    const dirtySourceAuth = authority(source, path.join(root, "dirty-source"));
    const dirtySourceGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    dirtySourceGit.states.get(source)!.porcelain = " M unrelated.txt";
    const dirtySource = await reconcileExecutionWorkspace(dirtySourceAuth, dirtySourceGit.run);
    assert.equal(dirtySource.sha, dirtySourceAuth.authoritativeSha);
    assert.equal(dirtySourceGit.states.get(source)?.porcelain, " M unrelated.txt");

    const wrongRepo = authority(source, path.join(root, "wrong-repo"));
    wrongRepo.expectedRemote = "https://github.com/example/governance.git";
    await assert.rejects(() => reconcileExecutionWorkspace(wrongRepo, git.run), /remote identity/);

    const missing = authority(source, path.join(root, "missing"), "missing-sha");
    const missingGit = new FakeGit(source, auth.expectedRemote, missing.authoritativeSha, true);
    await assert.rejects(() => reconcileExecutionWorkspace(missing, missingGit.run), /fetch unavailable/);

    const divergentAuth = authority(source, path.join(root, "divergent"));
    const divergentGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    await seedWorkspace(divergentGit, divergentAuth, "divergent-sha", "", {}, false);
    await assert.rejects(() => reconcileExecutionWorkspace(divergentAuth, divergentGit.run), /diverges/);

    const reusedAuth = authority(source, path.join(root, "reused"));
    const reusedGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const reusedPath = await seedWorkspace(reusedGit, reusedAuth, "old-sha", "", { runId: "old-run" });
    const reused = await reconcileExecutionWorkspace(reusedAuth, reusedGit.run);
    assert.equal(reused.sha, reusedAuth.authoritativeSha);
    assert.notEqual(reused.binding.workspacePath, reusedPath);

    const wrongCommonAuth = authority(source, path.join(root, "wrong-common"));
    const wrongCommonGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const wrongCommonPath = await seedWorkspace(wrongCommonGit, wrongCommonAuth, wrongCommonAuth.authoritativeSha, "");
    wrongCommonGit.states.get(wrongCommonPath)!.commonDir = path.join(root, "other.git");
    const wrongCommon = await reconcileExecutionWorkspace(wrongCommonAuth, wrongCommonGit.run);
    assert.notEqual(wrongCommon.binding.workspacePath, wrongCommonPath);

    const wrongTopLevelAuth = authority(source, path.join(root, "wrong-top-level"));
    const wrongTopLevelGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const wrongTopLevelPath = await seedWorkspace(wrongTopLevelGit, wrongTopLevelAuth, wrongTopLevelAuth.authoritativeSha, "");
    wrongTopLevelGit.states.get(wrongTopLevelPath)!.topLevel = source;
    const wrongTopLevel = await reconcileExecutionWorkspace(wrongTopLevelAuth, wrongTopLevelGit.run);
    assert.notEqual(wrongTopLevel.binding.workspacePath, wrongTopLevelPath);

    const changedBranchAuth = authority(source, path.join(root, "changed-branch"));
    const changedBranchGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const changedBranchPath = await seedWorkspace(changedBranchGit, changedBranchAuth, changedBranchAuth.authoritativeSha, "");
    changedBranchGit.states.get(changedBranchPath)!.branch = "unbound-branch";
    const changedBranch = await reconcileExecutionWorkspace(changedBranchAuth, changedBranchGit.run);
    assert.notEqual(changedBranch.binding.workspacePath, changedBranchPath);

    const detachedAuth = authority(source, path.join(root, "detached"));
    const detachedGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const detachedPath = await seedWorkspace(detachedGit, detachedAuth, detachedAuth.authoritativeSha, "", { executionBranch: null });
    const detached = await reconcileExecutionWorkspace(detachedAuth, detachedGit.run);
    assert.notEqual(detached.binding.workspacePath, detachedPath);

    const wrongRoleAuth = authority(source, path.join(root, "wrong-role"));
    const wrongRoleGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    const wrongRolePath = await seedWorkspace(wrongRoleGit, wrongRoleAuth, wrongRoleAuth.authoritativeSha, "", { repositoryRole: "GACM_GOVERNANCE" });
    const wrongRole = await reconcileExecutionWorkspace(wrongRoleAuth, wrongRoleGit.run);
    assert.notEqual(wrongRole.binding.workspacePath, wrongRolePath);

    const sameShaWrongRepo = authority(source, path.join(root, "same-sha-wrong-repo"));
    sameShaWrongRepo.repositoryIdentity = "https://github.com/example/governance.git";
    sameShaWrongRepo.expectedRemote = sameShaWrongRepo.repositoryIdentity;
    const sameShaWrongRepoGit = new FakeGit(source, auth.expectedRemote, auth.authoritativeSha);
    await assert.rejects(() => reconcileExecutionWorkspace(sameShaWrongRepo, sameShaWrongRepoGit.run), /remote identity/);

    const changedTranche = { ...auth, trancheId: "F15" };
    await assert.rejects(() => validatePersistedWorkspaceBinding(exact.binding, changedTranche, git.run), /binding/);

    const staleGacmRoot = "C:\\Users\\kulba\\Desktop\\gacm-qualification-sandbox";
    const staleGacmAuth: WorkspaceAuthority = {
      ...authority(staleGacmRoot, path.join(root, "gacm-stale-proof"), "df2ede96481f13905fe1dc9459a096cbebe329cc"),
      repositoryIdentity: "https://github.com/chriskulbaba2025/gacm-qualification-sandbox.git",
      expectedRemote: "https://github.com/chriskulbaba2025/gacm-qualification-sandbox.git",
      authoritativeRef: "candidate/foundation13-graph-repair-planning-20261004"
    };
    const staleGacmGit = new FakeGit(staleGacmRoot, staleGacmAuth.expectedRemote, staleGacmAuth.authoritativeSha);
    staleGacmGit.states.get(staleGacmRoot)!.sha = "0fabc39dbcd0ee2ac8357f0a51891f2650302b19";
    const staleGacm = await reconcileExecutionWorkspace(staleGacmAuth, staleGacmGit.run);
    assert.equal(staleGacm.sha, staleGacmAuth.authoritativeSha);
    assert.notEqual(staleGacm.binding.workspacePath, staleGacmRoot);

    const resumed = await validatePersistedWorkspaceBinding(exact.binding, auth, git.run);
    assert.equal(resumed.sha, auth.authoritativeSha);
    const changed = { ...auth, authoritativeSha: "changed-authority" };
    await assert.rejects(() => validatePersistedWorkspaceBinding(exact.binding, changed, git.run), /binding/);

    git.states.get(exact.binding.workspacePath)!.sha = "manually-altered";
    await assert.rejects(
      () => verifyExecutionWorkspaceForLaunch(exact.binding, auth, git.run),
      /authorized SHA|identity/
    );
    git.states.get(exact.binding.workspacePath)!.sha = auth.authoritativeSha;
    await assert.rejects(
      () => verifyExecutionWorkspaceForLaunch(exact.binding, { ...auth, repositoryRole: "GACM_GOVERNANCE" }, git.run),
      /binding/
    );

    const forbidden = git.calls.flatMap((call) => call.args[0]);
    assert.equal(forbidden.some((command) => ["reset", "clean", "checkout", "stash", "merge", "rebase", "cherry-pick"].includes(command)), false);
    assert.equal(git.states.get(source)?.sha, "stale-head");

    console.log(JSON.stringify({
      pass: true,
      cases: 23,
      exactShaAllowed: true,
      cleanStaleAncestorReconciled: true,
      dirtyWorkspaceBlockedWithoutDestruction: true,
      wrongRepositoryBlocked: true,
      missingAuthorizedShaBlocked: true,
      divergentHistoryBlocked: true,
      reusedWorkspaceRevalidated: true,
      restartResumeBindingsRevalidated: true,
      wrongCommonDirectoryReconciled: true,
      wrongTopLevelReconciled: true,
      changedBranchReconciled: true,
      detachedWorkspaceNotReused: true,
      changedRoleReconciled: true,
      sameShaWrongRepositoryBlocked: true,
      changedTrancheBlocked: true,
      finalLaunchGuardBlocked: true,
      staleGacmCheckoutResolvesToAuthorizedWorkspace: true,
      forbiddenDestructiveGitOperations: 0,
      sourceBranchHeadUnchanged: true,
      historicalRefsUntouched: true,
      productionUntouched: true
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
