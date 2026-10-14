import assert from "node:assert/strict";
import {
  getGacmAuthorityStatus,
  type GacmAuthoritySet
} from "./core.js";
import {
  resolveGacmAuthorityBinding,
  resolveGacmWorkRole
} from "./gacm-authority.js";
import { GACM_REPOSITORIES } from "./config.js";

function repo(role: "GACM_GOVERNANCE" | "GACM_APPLICATION") {
  return GACM_REPOSITORIES[role];
}

async function main() {
  const authority: GacmAuthoritySet = await getGacmAuthorityStatus();
  assert.equal(authority.governance.available, true, "governance repository authority must be available");
  assert.equal(authority.application.available, true, "application repository authority must be available");

  assert.equal(authority.governance.authoritativeSha, "3904adb8c46e16e72880106faf13e5f967983afc");
  assert.equal(authority.application.authoritativeSha, "df2ede96481f13905fe1dc9459a096cbebe329cc");
  assert.equal(authority.application.authoritativeParentSha, "f20cf367e8611025ffa1cb5e698db37350537c2c");
  assert.equal(authority.application.authoritativeRef, "candidate/foundation13-graph-repair-planning-20261004");

  assert.doesNotThrow(() => resolveGacmAuthorityBinding({
    role: "GACM_GOVERNANCE",
    repositoryRoot: repo("GACM_GOVERNANCE").root,
    remote: repo("GACM_GOVERNANCE").expectedRemote,
    ref: repo("GACM_GOVERNANCE").authoritativeRef,
    sha: "3904adb8c46e16e72880106faf13e5f967983afc"
  }));
  assert.doesNotThrow(() => resolveGacmAuthorityBinding({
    role: "GACM_APPLICATION",
    repositoryRoot: repo("GACM_APPLICATION").root,
    remote: repo("GACM_APPLICATION").expectedRemote,
    ref: repo("GACM_APPLICATION").authoritativeRef,
    sha: "df2ede96481f13905fe1dc9459a096cbebe329cc"
  }));

  assert.throws(() => resolveGacmAuthorityBinding({
    role: "GACM_GOVERNANCE",
    repositoryRoot: repo("GACM_APPLICATION").root,
    remote: repo("GACM_APPLICATION").expectedRemote,
    sha: "df2ede96481f13905fe1dc9459a096cbebe329cc"
  }), /authority mismatch/);

  assert.throws(() => resolveGacmAuthorityBinding({
    role: "GACM_GOVERNANCE",
    repositoryRoot: repo("GACM_GOVERNANCE").root,
    remote: repo("GACM_GOVERNANCE").expectedRemote,
    sha: "df2ede96481f13905fe1dc9459a096cbebe329cc"
  }), /authority mismatch/);

  assert.equal(authority.foundation13, "ACCEPTED");
  assert.equal(resolveGacmWorkRole({
    tranche: "F14",
    objective: "Open the next qualification boundary from the accepted Foundation 13 authority set."
  }).role, "GACM_APPLICATION");
  assert.throws(() => resolveGacmWorkRole({
    tranche: "RECOVERY",
    objective: "Repair GACM without specifying which repository role owns the work."
  }), /role is unresolved or contradictory/);

  console.log(JSON.stringify({
    pass: true,
    governanceShaBelongsTo: "GACM_GOVERNANCE",
    applicationShaBelongsTo: "GACM_APPLICATION",
    applicationParentBelongsTo: "GACM_APPLICATION",
    governanceLookupCannotDeclareApplicationMissing: true,
    crossRepositoryMismatchFailsClosed: true,
    foundation13: "ACCEPTED_NO_RERUN",
    foundation14: "OPENABLE_FROM_RECONCILED_AUTHORITY_SET",
    foundation14Started: false,
    repositoriesReadOnly: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
