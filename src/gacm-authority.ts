import {
  GACM_REPOSITORIES,
  type GacmRepositoryConfig,
  type GacmRepositoryRole
} from "./config.js";

export interface GacmAuthorityBinding {
  role: GacmRepositoryRole;
  repositoryRoot: string;
  remote: string;
  sha: string;
  ref?: string;
}

export interface GacmWorkRequest {
  tranche: string;
  objective: string;
  role?: GacmRepositoryRole;
}

export interface GacmAuthorityResolution {
  role: GacmRepositoryRole;
  repository: GacmRepositoryConfig;
  reason: "EXPLICIT_ROLE" | "EXPLICIT_BINDING" | "UNAMBIGUOUS_WORK_MARKER";
}

function normalize(value: string): string {
  return value.trim().replaceAll("/", "\\").replace(/\\+$/g, "").toLowerCase();
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

export function repositoryForRole(role: GacmRepositoryRole): GacmRepositoryConfig {
  return GACM_REPOSITORIES[role];
}

export function resolveGacmAuthorityBinding(
  binding: GacmAuthorityBinding
): GacmAuthorityResolution {
  const repository = repositoryForRole(binding.role);
  if (normalize(binding.repositoryRoot) !== normalize(repository.root)) {
    throw new Error(
      `GACM authority mismatch: ${binding.role} is bound to ${repository.root}, not ${binding.repositoryRoot}.`
    );
  }
  if (normalizeRemote(binding.remote) !== normalizeRemote(repository.expectedRemote)) {
    throw new Error(
      `GACM authority mismatch: ${binding.role} remote is ${repository.expectedRemote}, not ${binding.remote}.`
    );
  }
  if (binding.ref && binding.ref !== repository.authoritativeRef) {
    throw new Error(
      `GACM authority mismatch: ${binding.role} ref ${binding.ref} is not ${repository.authoritativeRef}.`
    );
  }
  if (binding.sha !== repository.authoritativeSha) {
    throw new Error(
      `GACM authority mismatch: ${binding.role} SHA ${binding.sha} is not ${repository.authoritativeSha}.`
    );
  }
  return { role: binding.role, repository, reason: "EXPLICIT_BINDING" };
}

export function resolveGacmWorkRole(request: GacmWorkRequest): GacmAuthorityResolution {
  if (request.role) {
    return { role: request.role, repository: repositoryForRole(request.role), reason: "EXPLICIT_ROLE" };
  }

  const text = `${request.tranche} ${request.objective}`;
  const governanceMarker = /GACM_GOVERNANCE|governance\s+repository|governance\s+authority/i.test(text);
  const applicationMarker = /GACM_APPLICATION|application\s+repository|qualification|candidate\s+(?:SHA|ref|repository)/i.test(text);
  const foundationQualification = /^F(?:OUNDATION\s*)?(?:13|14)\b/i.test(request.tranche.trim());

  if (governanceMarker === applicationMarker && !(foundationQualification && !governanceMarker)) {
    throw new Error(
      "GACM work repository role is unresolved or contradictory; provide GACM_GOVERNANCE or GACM_APPLICATION explicitly."
    );
  }
  const role: GacmRepositoryRole = governanceMarker ? "GACM_GOVERNANCE" : "GACM_APPLICATION";
  return { role, repository: repositoryForRole(role), reason: "UNAMBIGUOUS_WORK_MARKER" };
}

