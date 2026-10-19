import "dotenv/config";
import path from "node:path";

export type ProjectKey = "prysm" | "gacm" | "sandbox" | "falardeau";
export type GacmRepositoryRole = "GACM_GOVERNANCE" | "GACM_APPLICATION";

export interface ProjectConfig {
  key: ProjectKey;
  root: string;
  expectedRemote: string;
  proofRoot: string;
  executionRoot: string;
  authoritativeRef?: string;
  authoritativeSha?: string;
  allowDetachedHead?: boolean;
}

export interface GacmRepositoryConfig {
  role: GacmRepositoryRole;
  root: string;
  expectedRemote: string;
  authoritativeRef: string;
  authoritativeSha: string;
  authoritativeParentSha?: string;
  acceptedBoundary: "FOUNDATION_13_ACCEPTED";
}

export const GACM_REPOSITORIES: Record<GacmRepositoryRole, GacmRepositoryConfig> = {
  GACM_GOVERNANCE: {
    role: "GACM_GOVERNANCE",
    root: "C:\\Users\\kulba\\Desktop\\gacm-trial",
    expectedRemote: "https://github.com/chriskulbaba2025/gacm-trial.git",
    authoritativeRef: "governance/gacm-graph-foundation-13-repair-planning-20261004",
    authoritativeSha: "3904adb8c46e16e72880106faf13e5f967983afc",
    acceptedBoundary: "FOUNDATION_13_ACCEPTED"
  },
  GACM_APPLICATION: {
    role: "GACM_APPLICATION",
    root: "C:\\Users\\kulba\\Desktop\\gacm-qualification-sandbox",
    expectedRemote: "https://github.com/chriskulbaba2025/gacm-qualification-sandbox.git",
    authoritativeRef: "candidate/foundation13-graph-repair-planning-20261004",
    authoritativeSha: "df2ede96481f13905fe1dc9459a096cbebe329cc",
    authoritativeParentSha: "f20cf367e8611025ffa1cb5e698db37350537c2c",
    acceptedBoundary: "FOUNDATION_13_ACCEPTED"
  }
};

export const PROJECTS: Record<ProjectKey, ProjectConfig> = {
  prysm: {
    key: "prysm",
    root: "C:\\g\\p001",
    expectedRemote: "https://github.com/chriskulbaba2025/prysm-staging-isolated.git",
    authoritativeRef: "repair/prysm-evidence-accuracy-20261013",
    authoritativeSha: "bda9578029fda428e227bae774defb2e6c9a9809",
    allowDetachedHead: true,
    proofRoot: "C:\\Users\\kulba\\Downloads\\PRYSM-MCP-RUNS",
    executionRoot: "C:\\g\\p"
  },
  gacm: {
    key: "gacm",
    root: "C:\\Users\\kulba\\Desktop\\gacm-trial",
    expectedRemote: "https://github.com/chriskulbaba2025/gacm-trial.git",
    proofRoot: "C:\\Users\\kulba\\Downloads\\GACM-MCP-RUNS",
    executionRoot: "C:\\Users\\kulba\\Downloads\\GACM-MCP-EXECUTION-WORKSPACES"
  },
  falardeau: {
    key: "falardeau",
    // NOT ACTIVATED. This separate Astro app repo does not yet exist/has no accepted SHA.
    // Do not use the frozen WordPress source repository as the execution target.
    root: "C:\\Users\\kulba\\Desktop\\falardeau-astro-sanity",
    expectedRemote: "https://github.com/chriskulbaba2025/falardeau-astro-sanity.git",
    authoritativeRef: "main",
    // authoritativeSha intentionally absent: every Falardeau run must fail closed until pinned.
    proofRoot: "C:\\Users\\kulba\\Downloads\\FALARDEAU-GACM-RUNS",
    executionRoot: "C:\\Users\\kulba\\Downloads\\FALARDEAU-GACM-EXECUTION-WORKSPACES"
  },
  sandbox: {
    key: "sandbox",
    root: "C:\\Users\\kulba\\Desktop\\telegram-control-sandbox",
    expectedRemote: "https://github.com/chriskulbaba2025/telegram-control-sandbox.git",
    proofRoot: "C:\\Users\\kulba\\Downloads\\TELEGRAM-CONTROL-SANDBOX-RUNS",
    executionRoot: "C:\\Users\\kulba\\Downloads\\TELEGRAM-CONTROL-SANDBOX-EXECUTION-WORKSPACES"
  }
};

export const CODEX_MODEL = process.env.PRYSM_GACM_CODEX_MODEL || "gpt-5.6-luna";
export const CODEX_CLI_JS =
  process.env.PRYSM_GACM_CODEX_CLI_JS ||
  "C:\\Users\\kulba\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
export const WEBHOOK_URL = process.env.PRYSM_GACM_N8N_WEBHOOK_URL || "";

export function projectConfig(project: ProjectKey): ProjectConfig {
  return PROJECTS[project];
}

export function safeProjectPath(project: ProjectKey, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Path must be a non-empty relative path.");
  }
  const root = path.resolve(PROJECTS[project].root);
  const resolved = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("Path escapes the authorized project root.");
  }
  return resolved;
}
