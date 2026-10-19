import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  cancelCodexRun,
  configuredModel,
  getCodexTail,
  getGitDiff,
  getProjectStatus,
  readProjectFile,
  sendManualNotification,
  startCodexRun,
  webhookState
} from "./core.js";

const ProjectSchema = z.enum(["prysm", "gacm", "sandbox", "falardeau"]);

function asText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function asError(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "prysm-gacm-governed-execution", version: "0.1.0" },
    {
      instructions:
        "Use only for governed authorized projects. Falardeau remains dormant until pinned. Production is read-only. " +
        "Do not broaden project, model, tranche, or scope. One Codex run at a time."
    }
  );

  server.registerTool(
    "project_status",
    {
      description: "Return exact Git identity and dirty state for the authorized project.",
      inputSchema: z.object({ project: ProjectSchema })
    },
    async ({ project }) => {
      try { return asText(await getProjectStatus(project)); }
      catch (error) { return asError(error); }
    }
  );

  server.registerTool(
    "read_project_file",
    {
      description: "Read one text file inside the authorized project. Absolute paths and path escapes are rejected.",
      inputSchema: z.object({
        project: ProjectSchema,
        relativePath: z.string().min(1),
        maxBytes: z.number().int().positive().max(500_000).optional()
      })
    },
    async ({ project, relativePath, maxBytes }) => {
      try { return asText(await readProjectFile(project, relativePath, maxBytes)); }
      catch (error) { return asError(error); }
    }
  );

  server.registerTool(
    "git_diff",
    {
      description: "Return the current unstaged or staged diff from the authorized repo without changing it.",
      inputSchema: z.object({
        project: ProjectSchema,
        staged: z.boolean().optional().default(false)
      })
    },
    async ({ project, staged }) => {
      try {
        return {
          content: [{ type: "text" as const, text: await getGitDiff(project, staged) || "(no diff)" }]
        };
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_codex",
    {
      description:
        "Start one governed Codex run in an authorized project. Falardeau requires an approved SHA pin. " +
        "Uses the fixed configured model, workspace-write sandbox, no shell network, no commit/push/deploy, and a dedicated proof folder.",
      inputSchema: z.object({
        project: ProjectSchema,
        tranche: z.string().min(1).max(120),
        objective: z.string().min(1).max(12_000),
        gacmRole: z.enum(["GACM_GOVERNANCE", "GACM_APPLICATION"]).optional(),
        prysmBranch: z.string().min(1).max(240).optional(),
        prysmSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
        falardeauBranch: z.string().min(1).max(240).optional(),
        falardeauSha: z.string().regex(/^[0-9a-f]{40}$/i).optional()
      })
    },
    async ({ project, tranche, objective, gacmRole, prysmBranch, prysmSha, falardeauBranch, falardeauSha }) => {
      try {
        if ((prysmBranch && !prysmSha) || (!prysmBranch && prysmSha)) {
          throw new Error("PRYSM branch and full SHA must be supplied together.");
        }
        if ((falardeauBranch && !falardeauSha) || (!falardeauBranch && falardeauSha)) {
          throw new Error("Falardeau branch and full SHA must be supplied together.");
        }
        if (project !== "prysm" && (prysmBranch || prysmSha)) throw new Error("PRYSM authority cannot be used for another project.");
        if (project !== "falardeau" && (falardeauBranch || falardeauSha)) throw new Error("Falardeau authority cannot be used for another project.");
        const authorization = project === "prysm"
          ? prysmBranch && prysmSha ? { branch: prysmBranch, sha: prysmSha } : undefined
          : project === "falardeau"
            ? falardeauBranch && falardeauSha ? { branch: falardeauBranch, sha: falardeauSha } : undefined
            : undefined;
        return asText(await startCodexRun(project, objective, tranche, gacmRole, authorization));
      }
      catch (error) { return asError(error); }
    }
  );

  server.registerTool(
    "codex_status",
    {
      description: "Return persisted status plus bounded stdout/stderr/final-message tails for a governed Codex run.",
      inputSchema: z.object({
        runId: z.string().min(1),
        maxChars: z.number().int().positive().max(50_000).optional()
      })
    },
    async ({ runId, maxChars }) => {
      try { return asText(await getCodexTail(runId, maxChars)); }
      catch (error) { return asError(error); }
    }
  );

  server.registerTool(
    "cancel_codex",
    {
      description: "Cancel the single active governed Codex run. Does not affect unrelated processes.",
      inputSchema: z.object({ runId: z.string().min(1) })
    },
    async ({ runId }) => {
      try { return asText(await cancelCodexRun(runId)); }
      catch (error) { return asError(error); }
    }
  );

  server.registerTool(
    "notification_status",
    {
      description: "Report whether the n8n/Telegram webhook environment variable is configured.",
      inputSchema: z.object({})
    },
    async () => asText({ ...webhookState(), model: configuredModel() })
  );

  server.registerTool(
    "send_notification",
    {
      description: "Send a generic Telegram alert only when a workflow errors or is waiting for the user. This alert layer is not restricted to PRYSM/GACM.",
      inputSchema: z.object({
        context: z.string().min(1).max(160),
        event: z.enum(["ERROR", "WAITING_FOR_USER"]),
        message: z.string().min(1).max(2_000)
      })
    },
    async ({ context, event, message }) => {
      try { return asText(await sendManualNotification(context, event, message)); }
      catch (error) { return asError(error); }
    }
  );

  return server;
}

void serveStdio(createServer);
console.error("PRYSM/GACM governed MCP listening on stdio");
