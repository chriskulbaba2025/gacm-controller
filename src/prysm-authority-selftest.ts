import assert from "node:assert/strict";
import { PROJECTS } from "./config.js";
import { getProjectStatus, assertAcceptedPrysmRun } from "./core.js";

async function verify() {
  const expected = "bda9578029fda428e227bae774defb2e6c9a9809";
  const cfg = PROJECTS.prysm;

  assert.equal(cfg.authoritativeSha, expected);
  assert.equal(cfg.authoritativeRef, "repair/prysm-evidence-accuracy-20261013");

  const status = await getProjectStatus("prysm");
  assert.equal(status.sha, expected);
  assert.equal(status.branch, cfg.authoritativeRef);
  assert.equal(status.dirty, false);
  assert.equal(status.remote.replace(/\.git$/, ""), cfg.expectedRemote.replace(/\.git$/, ""));

  const authorized = { branch: cfg.authoritativeRef!, sha: expected };
  assert.doesNotThrow(() => assertAcceptedPrysmRun(authorized, status));
  assert.throws(() => assertAcceptedPrysmRun({ ...authorized, sha: "0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813" }, status), /accepted authority/);
  assert.throws(() => assertAcceptedPrysmRun({ ...authorized, branch: "repair/unapproved" }, status), /accepted authority/);
  assert.throws(() => assertAcceptedPrysmRun(authorized, { ...status, dirty: true }), /dirty/);
  assert.throws(() => assertAcceptedPrysmRun(authorized, { ...status, branch: "" }), /exact named staging branch/);
  assert.throws(() => assertAcceptedPrysmRun(authorized, { ...status, remote: "https://github.com/other/repo.git" }), /origin/);

  console.log("PRYSM AUTHORITY CHECK PASS");
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
