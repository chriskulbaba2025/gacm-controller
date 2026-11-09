# GACM pre-approved sequential batches — candidate runtime

**Status:** isolated feature branch only. Existing Windows controller is unchanged until explicitly reconciled and installed. Production, release, and existing Telegram operations are not altered.

## Native components
- `src/batch-coordinator.ts` — durable decision loop, bounded repair, exact independent receipts, replay HOLD.
- `src/batch-live.ts` — signed Ed25519 approval verification, shared batch worktree, Codex Luna Medium, actual Git changed surfaces, independent check contracts, accepted-tranche revalidation.
- `src/execution-lock.ts` — one global cross-process lock, shared with the existing single-run Codex launcher.
- `src/batch-action-gate.ts` — per-action machine ALLOW/DENY against a frozen GACM execution recipe digest.
- `src/index.ts` — opt-in `run_approved_batch` and `batch_status`, separate from existing commands.

## Configuration (no secrets in Git)
- `GACM_BATCH_APPROVER_PUBLIC_KEY`: PEM Ed25519 public key. The corresponding private key stays with the human operator, never Codex.
- `GACM_BATCH_APPROVAL_DIR`: directory outside repository/workspace containing an authenticated signed record `<approval.authorityRecord>.json`.
- `GACM_BATCH_CONTRACT_DIR`: directory outside the workspace with each tranche's independent verifier contract `<tranche.id>.json`, content digest bound in the frozen envelope.
- `GACM_BATCH_RECIPE_DIR`: directory outside the workspace with each tranche's frozen `GACM_EXECUTION_RECIPE_V1` `<tranche.id>.json`; SHA-256 must match `executionRecipeDigest` in the signed envelope. The two-step recipe must explicitly allow `CODEX_EXECUTE` via `codex-cli`, then `INDEPENDENT_VERIFY` via `gacm-local-verifier`, with exact action/parameter constraints.
- Reuse the configured Codex CLI and existing controller project paths. Confirm the installed CLI reports `Logged in using ChatGPT`; API-key login is rejected.

The canonical approval record is Ed25519-signed UTF-8 canonical JSON of fields `schema`, `status`, `batchId`, `authorityId`, `approverId`, `frozenDigest`, `expiresAt`, excluding its `signature` base64 field. `schema` = `GACM_SIGNED_BATCH_APPROVAL_V1`; `status` must equal `APPROVED`. Tampering, expiry, deletion or revocation fails closed.

Independent verifier contract example:

```json
{
  "schema": "GACM_BATCH_VERIFIER_V1",
  "checks": [
    {"id": "typecheck", "executable": "npm", "args": ["run", "typecheck"], "timeoutSeconds": 120},
    {"id": "tests", "executable": "npm", "args": ["test", "--", "--runInBand"], "timeoutSeconds": 300}
  ]
}
```

Contracts are only examples; the operator must approve project-specific tests and browser/runtime gates. Invalid or missing contract digest stops. The controller does not infer missing tests or downgrade incomplete proof to PASS.

## Required acceptance before any operational reliance
1. Exact Windows installed-source and dirty-worktree reconciliation, preserving active controller and work.
2. Machine-checkable **per-action GACM execution recipe authorization** is connected in candidate source but still requires independent installed-controller verification; do not rely on operational execution until accepted.
3. Check typed and focused CI on exact branch SHA. Run a sandbox three-tranche batch with one intentional failed audit and automatic successful repair, with no paid models or production.
4. Test actual Codex launch, approval authenticity/revocation, same worktree and candidate digests, negative scope/model/production gates, shutdown/restart, independent browser checks where required.
5. Enable separately and preserve rollback only after independent exact-candidate acceptance.

No feature-branch CI or coordinator selftest proves live installed Windows behavior. **No production, push, merge or deployment is authorized by a batch envelope.**
