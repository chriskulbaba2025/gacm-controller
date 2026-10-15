import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveGacmWorkRole } from "./gacm-authority.js";
import { getGacmAuthorityStatus, getProjectStatus } from "./core.js";
import { GACM_REPOSITORIES, projectConfig, type ProjectKey, type GacmRepositoryRole } from "./config.js";
import { reconcileExecutionWorkspace, type WorkspaceAuthority, type WorkspaceGit } from "./workspace-bootstrap.js";

const execFile = promisify(execFileCallback);

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireValue(name: string): string {
  const result = value(name)?.trim();
  if (!result) throw new Error(`Missing ${name}.`);
  return result;
}

async function gitAtRoot(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2_000_000
  });
  return String(stdout).trim();
}

async function main(): Promise<void> {
  const project = requireValue("--project") as ProjectKey;
  if (!(project === "prysm" || project === "gacm" || project === "sandbox")) {
    throw new Error("Project must be prysm, gacm, or sandbox.");
  }
  const trancheId = requireValue("--tranche");
  const runId = value("--run-id")?.trim() || `manual-${trancheId}-${crypto.randomBytes(4).toString("hex")}`;

  let repositoryRole: string;
  let repositoryRoot: string;
  let repositoryIdentity: string;
  let expectedRemote: string;
  let authoritativeRef: string;
  let authoritativeSha: string;
  if (project === "gacm") {
    const role = requireValue("--role") as GacmRepositoryRole;
    if (role !== "GACM_GOVERNANCE" && role !== "GACM_APPLICATION") {
      throw new Error("GACM manual execution requires --role GACM_GOVERNANCE or GACM_APPLICATION.");
    }
    const resolved = resolveGacmWorkRole({ role, tranche: trancheId, objective: "manual governed workspace resolution" });
    const authority = await getGacmAuthorityStatus();
    const selected = authority[resolved.role === "GACM_GOVERNANCE" ? "governance" : "application"];
    if (!selected.available) throw new Error(selected.error || "GACM authority is unavailable.");
    repositoryRole = resolved.role;
    repositoryRoot = selected.root;
    repositoryIdentity = selected.expectedRemote;
    expectedRemote = selected.expectedRemote;
    authoritativeRef = selected.authoritativeRef;
    authoritativeSha = selected.authoritativeSha;
  } else {
    const status = await getProjectStatus(project);
    const cfg = projectConfig(project);
    repositoryRole = `${project.toUpperCase()}_PROJECT`;
    repositoryRoot = cfg.root;
    repositoryIdentity = cfg.expectedRemote;
    expectedRemote = cfg.expectedRemote;
    authoritativeRef = cfg.authoritativeRef || status.branch;
    authoritativeSha = cfg.authoritativeSha || status.sha;
    if (!authoritativeRef || !authoritativeSha) throw new Error("Project has no explicit branch and SHA authority.");
  }

  const authority: WorkspaceAuthority = {
    runId, trancheId, repositoryRole, repositoryRoot, repositoryIdentity,
    expectedRemote, authoritativeRef, authoritativeSha,
    executionRoot: projectConfig(project).executionRoot
  };
  const workspace = await reconcileExecutionWorkspace(authority, gitAtRoot as WorkspaceGit);
  console.log(JSON.stringify({
    project, repositoryRole, runId, trancheId,
    repositoryIdentity: workspace.repositoryIdentity,
    authorizedSha: authoritativeSha,
    workspacePath: workspace.binding.workspacePath,
    executionBranch: workspace.binding.executionBranch,
    workspaceHead: workspace.sha,
    clean: !workspace.dirty,
    manualCodexCommand: `codex exec -C "${workspace.binding.workspacePath}" -m gpt-5.6-luna`
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
