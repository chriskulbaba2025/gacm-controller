import assert from "node:assert/strict";
import { GACM_REPOSITORIES } from "./config.js";
import { resolveGacmAuthorityBinding, resolveGacmWorkRole } from "./gacm-authority.js";

// Pure source-contract verification. Unlike gacm-authority-selftest, this fixture
// does not claim two independent local Windows source checkouts are mounted in CI.
const governance = GACM_REPOSITORIES.GACM_GOVERNANCE;
const application = GACM_REPOSITORIES.GACM_APPLICATION;

assert.equal(governance.authoritativeSha, "3904adb8c46e16e72880106faf13e5f967983afc");
assert.equal(application.authoritativeSha, "df2ede96481f13905fe1dc9459a096cbebe329cc");
assert.equal(application.authoritativeParentSha, "f20cf367e8611025ffa1cb5e698db37350537c2c");

for (const item of [governance, application]) {
  assert.doesNotThrow(() => resolveGacmAuthorityBinding({
    role: item.role,
    repositoryRoot: item.root,
    remote: item.expectedRemote,
    ref: item.authoritativeRef,
    sha: item.authoritativeSha
  }));
}

assert.throws(() => resolveGacmAuthorityBinding({
  role: "GACM_GOVERNANCE",
  repositoryRoot: application.root,
  remote: application.expectedRemote,
  sha: application.authoritativeSha
}), /authority mismatch/);

assert.throws(() => resolveGacmAuthorityBinding({
  role: "GACM_GOVERNANCE",
  repositoryRoot: governance.root,
  remote: governance.expectedRemote,
  sha: application.authoritativeSha
}), /authority mismatch/);

assert.equal(resolveGacmWorkRole({
  tranche: "F14",
  objective: "Open the next qualification boundary from the accepted Foundation 13 authority set."
}).role, "GACM_APPLICATION");

assert.throws(() => resolveGacmWorkRole({
  tranche: "RECOVERY",
  objective: "Repair GACM without specifying which repository role owns the work."
}), /role is unresolved or contradictory/);

console.log("GACM role boundaries: isolated source-contract checks PASS; live local authority check remains HOLD");
