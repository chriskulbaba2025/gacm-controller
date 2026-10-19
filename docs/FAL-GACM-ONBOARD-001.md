# FAL-GACM-ONBOARD-001 — Falardeau dormant-controller integration

Status: **DRAFT / CODE CANDIDATE / NOT ACTIVATED / NO RELEASE AUTHORITY**
Date: 2026-10-19

## Boundaries and authority

- Existing GACM controller: `chriskulbaba2025/gacm-controller`, base feature-branch commit `076db8cc67c36d04804ad9563524ad6e3d825156`.
- Immutable WordPress source inventory: `chriskulbaba2025/falardeau-current-main`, SHA `d32a673daa85dd5c9ba7f1103ef1e7010311e0c7`. Never use this repository for Astro build execution.
- Proposed, **not yet available** Astro application repo: `chriskulbaba2025/falardeau-astro-sanity`; local checkout `C:\Users\kulba\Desktop\falardeau-astro-sanity` (proposed, unverified).
- Separate Astro deployment must be approved in a later tranche; WordPress staging and production are not to be changed.
- GitHub source + current-state + decisions + constraints are the durable authorities. Each authorized change references exact source/target SHAs and evidence. No chat-only PASS.
- Codex for Falardeau must run `gpt-5.6-luna` only. Other controller projects retain their existing behaviour.

## Implemented candidate (not acceptance)

- Registers `falardeau` as a separate project while deliberately omitting `authoritativeSha`. A Falardeau run fails with NOT ACTIVATED **before workspace creation** until a future, independently accepted Astro repo SHA is pinned.
- An authorized future launch must supply branch + 40-character SHA, verify the configured `gpt-5.6-luna` model, exact configured repo origin, clean named branch and exact SHA. Never substitute the WordPress source repository.
- Falardeau uses an existing-workspace-only gate, separate proof root, project/run-ID validation and SQLite status schema. A workspace is not fabricated.
- MCP and Telegram accept explicit Falardeau project identity but cannot launch an unpinned run. Natural-language change requests cannot silently bypass the explicit-SHA requirement. `publish` remains sandbox-only.
- Single run, fail-closed status persistence, bounded proof requirements, no Codex commit/push/deploy, no paid/provider actions and no production writes retain their existing controller restrictions.
- Preserves PRYSM and GACM repository role mappings and operational constraints. The existing controller singleton must **not** be replaced without a separate runtime acceptance.

## Test boundaries

Source tests to run on the exact final draft-PR SHA:

```powershell
npm run typecheck
npm run falardeau:authority:selftest
npm run telegram:selftest
npm run result:selftest
npm run workspace:selftest
npm run selftest
```

`npm run selftest` requires local authorized PRYSM/GACM/sandbox checkouts and may not run in hosted CI; label it **local runtime HOLD** when not executed. Do not claim tests passed from code review alone.

Negative controls must establish: missing pin, missing/mismatched branch/SHA, remote pointing to WordPress, dirty checkout, incorrect model, unbound workspace, malformed status/run ID, unapproved publish and false COMPLETE all fail closed; existing projects must continue to work.

## Remaining activation gates (not authorized by this PR)

1. Create/authorize the new Astro app repository, establish its owner/remote/branch/head SHA, and put durable project governance documents in GitHub.
2. Complete read-only WordPress staging parity inspection and preserve any approved planner submission and article changes absent from the earlier theme ZIP.
3. In a **separate authorized** controller change, pin the accepted Astro application SHA and verify the local checkout/workspace and clean runtime identity.
4. Run actual Windows TypeScript/regression suite, sandboxed read-only Falardeau launch negative test, restart/singleton and status-resume acceptance, Telegram response/notification verification, and record proof under a dedicated `C:\Users\kulba\Downloads\FAL-GACM-ONBOARD-001\REPORT.md`.
5. Obtain separate approval before any PR merge, controller rollout, commit/push by Codex, Vercel/Sanity initialization, paid call, DNS edit or staging/production deployment.

Current state is **candidate only**. Never assert activated, tested, released or deployed based on this document or the existence of a draft PR.
