import assert from "node:assert/strict";
import { buildOperatorAlert, classifyGovernedResult } from "./core.js";

assert.equal(
  classifyGovernedResult(0, false, "RESULT:\nPASS — all required checks passed.\n\nBLOCKER:\nNone", true),
  "COMPLETE"
);
assert.equal(
  classifyGovernedResult(0, false, "RESULT:\nPASS — all required checks passed.", false),
  "BLOCKED"
);
assert.equal(
  classifyGovernedResult(0, false, "RESULT:\nBLOCKED — command runner unavailable.", false),
  "BLOCKED"
);
assert.equal(
  classifyGovernedResult(0, false, "RESULT:\nHOLD — acceptance evidence missing.", true),
  "BLOCKED"
);
assert.equal(
  classifyGovernedResult(0, false, "RESULT:\nFAILED — regression failed.", true),
  "FAILED"
);
assert.equal(
  classifyGovernedResult(1, false, "RESULT:\nPASS", true),
  "FAILED"
);
assert.equal(
  classifyGovernedResult(0, true, "RESULT:\nPASS", true),
  "CANCELLED"
);
assert.equal(
  classifyGovernedResult(0, false, "No governed result heading", true),
  "BLOCKED"
);

const blockedFinal = [
  "RESULT:",
  "- Repository unchanged at SHA 1daab4f; still 1-ahead/29-behind.",
  "",
  "BLOCKER:",
  "- The Foundation 13 candidate object/ref is absent locally.",
  "",
  "NEXT ACTION:",
  "- Stop. Acquire and verify the exact Foundation 13 candidate in a clean context."
].join("\n");

const blockedProof = [
  "# Proof",
  "",
  "## Safest exact next action",
  "",
  "In a new explicitly authorized tranche, first archive the two tracked diffs and status evidence outside the repository, then acquire and verify the exact authoritative Foundation 13 candidate in a separate clean candidate context. Do not merge, rebase, transplant, commit, push, deploy, or touch main.",
  "",
  "## Checks",
  "PASS"
].join("\n");

const blockedAlert = buildOperatorAlert(
  "BLOCKED",
  "gacm",
  "gacm-test-run",
  blockedFinal,
  blockedProof,
  "C:\\proof"
);

assert.match(blockedAlert.message, /Result: BLOCKED/);
assert.match(blockedAlert.message, /WHAT HAPPENED:/);
assert.match(blockedAlert.message, /BLOCKER:/);
assert.match(blockedAlert.message, /SUGGESTED NEXT ACTION:/);
assert.match(
  blockedAlert.nextAction,
  /archive the two tracked diffs and status evidence/
);
assert.match(
  blockedAlert.message,
  /SEND THIS TO THE CONTROL BOT:/
);
assert.match(
  blockedAlert.suggestedMessage,
  /^GACM: In a new explicitly authorized tranche/
);
assert.doesNotMatch(
  blockedAlert.nextAction,
  /^- Stop\. Acquire/
);

const completeAlert = buildOperatorAlert(
  "COMPLETE",
  "prysm",
  "prysm-test-run",
  [
    "RESULT:",
    "PASS — acceptance complete.",
    "",
    "BLOCKER:",
    "None.",
    "",
    "NEXT ACTION:",
    "Begin the next governed tranche only after reviewing this proof."
  ].join("\n"),
  "",
  "C:\\proof"
);
assert.match(completeAlert.message, /Result: COMPLETE/);
assert.match(
  completeAlert.message,
  /Begin the next governed tranche only after reviewing this proof/
);

console.log(JSON.stringify({
  pass: true,
  exitZeroDoesNotEqualPass: true,
  proofRequiredForComplete: true,
  blockedRecognized: true,
  holdRecognized: true,
  failedRecognized: true,
  cancelledRecognized: true,
  missingResultFailsClosed: true,
  blockedAlertIncludesSuggestedAction: true,
  proofSafestActionOverridesFinalNextAction: true,
  completeAlertIncludesNextAction: true
}, null, 2));
