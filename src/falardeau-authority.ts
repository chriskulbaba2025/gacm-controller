import type { ProjectConfig } from "./config.js";

export const FALARDEAU_WORDPRESS_BASELINE = {
  repository: "chriskulbaba2025/falardeau-current-main",
  sha: "d32a673daa85dd5c9ba7f1103ef1e7010311e0c7"
} as const;

export interface FalardeauRunAuthorization {
  branch: string;
  sha: string;
}

export interface FalardeauSourceStatus {
  branch: string;
  sha: string;
  remote: string;
  dirty: boolean;
}

const SHA_40 = /^[0-9a-f]{40}$/i;

function normalizeRemote(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

/** Check before workspace creation, proof writes, SQLite persistence, or Codex launch. */
export function assertAcceptedFalardeauRun(
  cfg: ProjectConfig,
  authorization: FalardeauRunAuthorization | undefined,
  status: FalardeauSourceStatus,
  configuredModel: string
): void {
  if (cfg.key !== "falardeau") throw new Error("Falardeau guard requires Falardeau project configuration.");
  if (configuredModel !== "gpt-5.6-luna") {
    throw new Error("Falardeau model authority failure: only gpt-5.6-luna is authorized.");
  }
  if (!cfg.authoritativeRef || !cfg.authoritativeSha || !SHA_40.test(cfg.authoritativeSha)) {
    throw new Error("Falardeau NOT ACTIVATED: exact Astro application SHA is not yet accepted/pinned.");
  }
  if (!authorization || !SHA_40.test(authorization.sha) ||
      authorization.branch !== cfg.authoritativeRef ||
      authorization.sha !== cfg.authoritativeSha) {
    throw new Error("Falardeau run branch/SHA must match the accepted Astro repository authority.");
  }
  if (normalizeRemote(status.remote) !== normalizeRemote(cfg.expectedRemote)) {
    throw new Error("Falardeau repository origin mismatch; WordPress baseline is not an execution target.");
  }
  if (status.branch !== cfg.authoritativeRef || status.sha !== cfg.authoritativeSha || status.dirty) {
    throw new Error("Falardeau execution requires the exact clean Astro branch and pinned SHA.");
  }
}
