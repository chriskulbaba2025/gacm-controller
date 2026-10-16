# PRYSM / GACM Governed MCP v0.1

## Current single-staging PRYSM authority (2026-10-16)

**Governing source of truth:** [PRYSM single-staging Telegram/GACM operating decision](https://github.com/chriskulbaba2025/prysm-project-context/blob/main/DECISION_PRYSM_GACM_SINGLE_STAGING_OPERATING_MODEL_2026-10-16.md) and the latest [PRYSM CURRENT_STATE.md](https://github.com/chriskulbaba2025/prysm-project-context/blob/main/CURRENT_STATE.md). Read these and current application/controller GitHub SHAs before any handoff or launch.

- **Only PRYSM target:** `chriskulbaba2025/prysm-staging-isolated`; staging ref `repair/prysm-evidence-accuracy-20261013` and accepted SHA `0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813` as verified 2026-10-16.
- **GitHub controller `main` config:** `src/config.ts` expects `C:\g\p001`, the above exact ref/SHA and execution worktrees under `C:\g\p`. This is **source code only**, not proof the running Telegram process has these settings.
- **Observed local discrepancy:** user-read `C:\Users\kulba\Desktop\prysm-gacm-mcp\src\config.ts` still points at `C:\Users\kulba\Desktop\prysm-staging-isolated` without the newer accepted SHA binding. Telegram has run from that outdated configuration and reported a DIRTY checkout. **Do not run Codex before in-place reconciliation; preserve all existing dirty work.**
- **Improved harness candidate** `e627fcaba391661a6332eaa21cf99dbbbafb92a5` is user-reported local/unpromoted; its child acceptance remains HOLD. Do not claim it runs live.
- **Production boundary:** the separate `chriskulbaba2025/production-prysm` project remains untouched. Do not create another staging application or configuration.
- **Operating goal:** use Telegram as real controller of verified PRYSM staging coding. Maintain durable resume, exact source identity, dependent tests, proof and stage-gated release. At this README version PRYSM/GACM push and deployment from Telegram are explicitly **not** supported; browser/live end-to-end acceptance is **not** established.
- **Exact current next action:** reconcile the existing local controller's executing code/config and staging checkout **read-only**, then make one minimal, reversible in-place startup correction, verify Telegram status matches GitHub and return to PRYSM's preserved data-accuracy repair. No second controller installation, no new staging, no resets, no production changes.

The legacy background sections below describe historical behavior; this current section and the dated PRYSM governance decision control when conflicting.

Purpose: a narrow local MCP for governed PRYSM and GACM updates only.

## Authorized projects

- PRYSM: GitHub-controller accepted source checkout `C:\g\p001`, remote `chriskulbaba2025/prysm-staging-isolated`, pinned staging ref/SHA above. Existing local running-controller config has **not** yet been reconciled.
- GACM: `C:\Users\kulba\Desktop\gacm-trial`

The server fail-closes if the Git top-level or `origin` remote does not match the fixed configuration.

## Exposed tools

1. `project_status`
2. `read_project_file`
3. `git_diff`
4. `run_codex`
5. `codex_status`
6. `cancel_codex`
7. `notification_status`
8. `send_notification`

There is no general shell tool, arbitrary filesystem tool, Git push tool, deploy tool, branch-switch tool, or production mutation tool.

For manual governed workspace resolution, use the canonical bootstrap before opening
Codex. It verifies the repository role, remote authority, exact SHA, and durable
workspace binding, then prints the exact workspace/Codex command:

```powershell
.\scripts\resolve-governed-workspace.ps1 -Project gacm -Role GACM_APPLICATION -Tranche F14
```

Never open Codex directly from a configured or historical checkout.

## Codex governance

`run_codex`:

- uses fixed model `gpt-5.6-luna` unless the server process is explicitly configured with `PRYSM_GACM_CODEX_MODEL`;
- permits one active run at a time;
- runs Codex with `workspace-write`;
- sets Codex-generated shell network access to false;
- tells Codex not to commit, push, deploy, publish, promote, switch branches, or mutate production;
- preserves pre-existing dirty working-tree changes;
- creates a dedicated proof folder under:
  - `C:\Users\kulba\Downloads\PRYSM-MCP-RUNS`
  - `C:\Users\kulba\Downloads\GACM-MCP-RUNS`
- persists prompt, pre-run Git state, stdout, stderr, final message, and status JSON per run.

## n8n / Telegram notifications

Set this environment variable before starting the MCP:

`PRYSM_GACM_N8N_WEBHOOK_URL=<full webhook URL>`

Completion, failure, and cancellation events are POSTed to that URL. The server reports `NOT_CONFIGURED` rather than guessing a URL.

## Start locally — current manual commands (single launcher not yet implemented)

**Telegram bot** (only after verifying this local checkout/config against current GitHub and preserving pre-existing dirty changes):

```powershell
cd C:\Users\kulba\Desktop\prysm-gacm-mcp
npm run telegram
```

The Telegram controller uses a single-instance lock on `127.0.0.1:49831`. It is **not yet verified** to auto-check its running code SHA versus GitHub. Leave the live process alone while performing read-only authority diagnosis; any code repair requires a controlled operator restart.

**Local MCP stdio server** (different process, not Telegram polling):

```powershell
cd C:\Users\kulba\Desktop\prysm-gacm-mcp
npm start
```

These are existing manual entrypoints. The requested one-command fail-closed launcher is a planned correction, **not** a completed feature.

## Verification

```powershell
npm run typecheck
npm run selftest
npx tsx src/protocoltest.ts
```

The protocol test verifies tool discovery, repo status access, path-escape rejection, and notification-status access without making a paid Codex model call.

## ChatGPT connection

ChatGPT cannot directly reach a local stdio MCP. Connect it through an approved remote MCP endpoint or OpenAI Secure MCP Tunnel. Do not expose the local server publicly merely to make it reachable.
