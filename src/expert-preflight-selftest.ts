import assert from "node:assert/strict";
import { governedPrompt } from "./core.js";

const pre = {
  root: "C:\\governed-workspace",
  branch: "isolated-candidate",
  sha: "a".repeat(40),
  dirty: false,
  porcelain: ""
} as Parameters<typeof governedPrompt>[4];

for (const project of ["gacm", "prysm", "sandbox"] as const) {
  const rendered = governedPrompt(
    project,
    "Inspect only this existing authorized source.",
    "PREFLIGHT-TEST",
    "C:\\proof",
    pre
  );
  for (const required of [
    "MANDATORY EXPERT PREFLIGHT",
    "Expert omissions",
    "Raw source",
    "Established method",
    "Independent verification",
    "Risks",
    "EXPERT_PREFLIGHT: REVIEWED | HOLD | NOT_APPLICABLE | NOT_VERIFIED",
    "SOURCE_OF_TRUTH",
    "EXPERT_OMISSIONS",
    "RAW_EVIDENCE",
    "ACCEPTANCE",
    "SCOPE_CHANGE",
    "HOLD before editing",
    "Keep objective, scope, model, provider, cost, retries, tranche, production and approvals frozen.",
    "Never turn observations into scope changes",
    "Production is read-only",
    "Do not change model, objective, tranche, repo, or scope."
  ]) {
    assert.ok(rendered.includes(required), `${project}: missing ${required}`);
  }
  assert.ok(rendered.includes("Authorized tranche: PREFLIGHT-TEST"));
  assert.ok(rendered.includes("Inspect only this existing authorized source."));
  assert.ok(rendered.includes("Write proof to:"));
}
console.log("Expert preflight rendered prompt assertions: PASS for gacm/prysm/sandbox");
