# PRYSM / GACM Governed MCP v0.1

Purpose: a narrow local MCP for governed PRYSM and GACM updates only.

## Authorized projects

- PRYSM: `C:\Users\kulba\Desktop\prysm-staging-isolated`
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

## Start locally

```powershell
cd C:\Users\kulba\Desktop\prysm-gacm-mcp
npm start
```

The server uses MCP stdio.

## Verification

```powershell
npm run typecheck
npm run selftest
npx tsx src/protocoltest.ts
```

The protocol test verifies tool discovery, repo status access, path-escape rejection, and notification-status access without making a paid Codex model call.

## ChatGPT connection

ChatGPT cannot directly reach a local stdio MCP. Connect it through an approved remote MCP endpoint or OpenAI Secure MCP Tunnel. Do not expose the local server publicly merely to make it reachable.
