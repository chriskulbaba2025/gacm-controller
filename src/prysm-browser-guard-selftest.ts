import assert from "node:assert/strict";
import {
  PRYSM_BROWSER_ACCEPTANCE,
  PRYSM_BROWSER_POLICY,
  assertPrysmBrowserPlanAllowed,
  browserPlanViolation,
  prysmBrowserGuardPrompt
} from "./prysm-browser-guard.js";

assert.equal(browserPlanViolation("Run Playwright and verify the PRYSM visual acceptance.")?.startsWith(PRYSM_BROWSER_POLICY), true);
assert.throws(
  () => assertPrysmBrowserPlanAllowed("prysm", "Open Chromium and run browser testing."),
  new RegExp(PRYSM_BROWSER_POLICY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
);
assert.equal(browserPlanViolation("Run unit tests. Browser acceptance remains HOLD until Chris confirms."), null);
assert.doesNotThrow(() => assertPrysmBrowserPlanAllowed("prysm", "Chris performs real browser and visual acceptance later; Codex remains HOLD."));
assert.doesNotThrow(() => assertPrysmBrowserPlanAllowed("gacm", "Run browser diagnostics for the GACM dashboard."));
const prompt = prysmBrowserGuardPrompt("prysm");
assert.match(prompt, new RegExp(PRYSM_BROWSER_POLICY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(prompt, new RegExp(PRYSM_BROWSER_ACCEPTANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.equal(prysmBrowserGuardPrompt("gacm"), "");
console.log(JSON.stringify({ policy: PRYSM_BROWSER_POLICY, acceptance: PRYSM_BROWSER_ACCEPTANCE, positive: true, negative: true }));
