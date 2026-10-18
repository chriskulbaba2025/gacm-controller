import "dotenv/config";
import { mkdir, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  cancelCodexRun,
  getCodexTail,
  getProjectStatus,
  publishSandboxRun,
  sendManualNotification,
  startCodexRun
} from "./core.js";
import { RunStatusReadError } from "./status-contract.js";
import type { ProjectKey } from "./config.js";
import { interpretWithLlm, type LlmIntent } from "./llm-interpreter.js";

export interface PendingProposal {
  sourceText: string;
  canonicalCommand: string;
  action: "run" | "stop" | "publish";
  project: ProjectKey;
  tranche?: string;
  createdAt: string;
}

export interface ControllerState {
  updateOffset: number;
  initialized: boolean;
  lastRunId?: string;
  lastProject?: ProjectKey;
  pendingProposal?: PendingProposal;
}

export interface CommandResult {
  reply: string;
  state?: ControllerState;
}

export interface ControllerDeps {
  getProjectStatus: typeof getProjectStatus;
  getCodexTail: typeof getCodexTail;
  cancelCodexRun: typeof cancelCodexRun;
  startCodexRun: typeof startCodexRun;
  publishSandboxRun: typeof publishSandboxRun;
  interpretWithLlm: typeof interpretWithLlm;
}

export const defaultDeps: ControllerDeps = {
  getProjectStatus,
  getCodexTail,
  cancelCodexRun,
  startCodexRun,
  publishSandboxRun,
  interpretWithLlm
};

const RUNTIME_DIR = path.resolve(process.cwd(), "runtime");
const STATE_PATH = path.join(RUNTIME_DIR, "telegram-controller-state.json");

function isProject(value: string): value is ProjectKey {
  return value === "prysm" || value === "gacm" || value === "sandbox";
}

function normalizeCommand(text: string): string {
  return text.trim().replace(/^\//, "");
}

function splitBoundedInstruction(body: string): { tranche: string; objective: string } | null {
  const idx = body.indexOf("::");
  if (idx < 1) return null;
  const tranche = body.slice(0, idx).trim();
  const objective = body.slice(idx + 2).trim();
  if (!tranche || !objective) return null;
  return { tranche, objective };
}

function parsePrysmTargetedInstruction(body: string): { branch: string; sha: string; tranche: string; objective: string } | null {
  const match = body.match(/^(\S+)\s+([0-9a-f]{40})\s+([\s\S]+)$/i);
  if (!match) return null;
  const bounded = splitBoundedInstruction(match[3]);
  return bounded ? { branch: match[1], sha: match[2], ...bounded } : null;
}

function compact(value: string, max = 2800): string {
  return value.length <= max ? value : value.slice(0, max) + "\n…[truncated]";
}

function normalizeNaturalText(text: string): string {
  const typoMap: Record<string, string> = {
    teh: "the",
    adn: "and",
    wo: "so",
    ahed: "ahead",
    aheads: "ahead",
    workign: "working",
    workng: "working",
    wrking: "working",
    cleen: "clean",
    clena: "clean",
    dity: "dirty",
    drity: "dirty",
    driey: "dirty",
    trree: "tree",
    ttree: "tree",
    gcam: "gacm",
    gacn: "gacm",
    gam: "gacm",
    prsym: "prysm",
    pyrsm: "prysm",
    statu: "status",
    statsu: "status",
    chek: "check",
    chekc: "check",
    chcek: "check",
    verfy: "verify",
    verfiy: "verify",
    contine: "continue",
    continute: "continue",
    finised: "finished",
    finishd: "finished"
  };

  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => typoMap[token] ?? token)
    .join(" ");
}

function explicitProjectFromText(text: string): ProjectKey | null {
  const normalized = normalizeNaturalText(text);
  const matches = (["prysm", "gacm", "sandbox"] as const).filter((project) =>
    new RegExp(`\\b${project}\\b`, "i").test(normalized)
  );
  return matches.length === 1 ? matches[0] : null;
}

function hasAffirmativeKeywordIntent(text: string, actionPattern: RegExp): boolean {
  const lower = text.toLowerCase();
  actionPattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = actionPattern.exec(lower)) !== null) {
    const before = lower.slice(Math.max(0, match.index - 240), match.index);
    const negated =
      /(?:\bdo\s+not\b|\bdon't\b|\bdont\b|\bnever\b|\bno\b)[^.!?;]{0,240}$/.test(before);

    if (!negated) return true;
  }

  return false;
}

function hasAffirmativePublishIntent(text: string): boolean {
  return hasAffirmativeKeywordIntent(text, /\b(push|publish)\b/g);
}

function hasAffirmativeStopIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const actionPattern = /\b(stop|cancel|halt|kill)\b/g;
  let match: RegExpExecArray | null;

  while ((match = actionPattern.exec(lower)) !== null) {
    const before = lower.slice(Math.max(0, match.index - 240), match.index);
    const after = lower.slice(match.index + match[0].length, match.index + match[0].length + 80);

    const negated =
      /(?:\bdo\s+not\b|\bdon't\b|\bdont\b|\bnever\b|\bno\b)[^.!?;]{0,240}$/.test(before);
    const conditional = /^\s+(?:if|unless|when)\b/.test(after);

    if (!negated && !conditional) return true;
  }

  return false;
}

function hasAffirmativeChangeIntent(text: string): boolean {
  return hasAffirmativeKeywordIntent(
    text,
    /\b(move|continue|proceed|advance|start|begin|fix|repair|clean|change|update|implement|build|create|modify|audit|verify|test|run|finish|complete|address|resolve|make|diagnose|investigate|determine|identify|inspect|assess|review)\b/g
  );
}

function deriveTrancheLabel(text: string): string {
  const candidates: Array<{ index: number; label: string }> = [];
  const patterns: Array<{
    regex: RegExp;
    label: (match: RegExpExecArray) => string;
  }> = [
    {
      regex: /\bfoundation\s*([0-9]+[a-z]?)\b/gi,
      label: (match) => `F${match[1].toUpperCase()}`
    },
    {
      regex: /\btranche\s*([a-z0-9._-]+)\b/gi,
      label: (match) => match[1].toUpperCase()
    },
    {
      regex: /\bstage\s*([0-9]+[a-z]?)\b/gi,
      label: (match) => `STAGE-${match[1].toUpperCase()}`
    },
    {
      regex: /\bphase\s*([0-9]+[a-z]?)\b/gi,
      label: (match) => `PHASE-${match[1].toUpperCase()}`
    },
    {
      regex: /\bF([0-9]+[a-z]?)\b/g,
      label: (match) => `F${match[1].toUpperCase()}`
    }
  ];

  for (const { regex, label } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      candidates.push({ index: match.index, label: label(match) });
    }
  }

  if (candidates.length === 0) return "USER-REQUEST";
  candidates.sort((a, b) => a.index - b.index);
  return candidates[candidates.length - 1].label;
}

type NaturalInterpretation =
  | { kind: "immediate"; canonicalCommand: string }
  | { kind: "proposal"; proposal: PendingProposal }
  | { kind: "clarify"; reply: string; allowLlmFallback?: boolean };

export function interpretNaturalLanguage(
  rawText: string,
  state: ControllerState
): NaturalInterpretation {
  const sourceText = rawText.trim();
  const normalized = normalizeNaturalText(sourceText);
  const lower = normalized;
  const explicitProject = explicitProjectFromText(sourceText);
  const project = explicitProject ?? state.lastProject ?? null;

  if (
    /\b(status|current state|where are we|how is|how's|what is happening|what's happening|running|active|check)\b/i.test(normalized)
  ) {
    return {
      kind: "immediate",
      canonicalCommand: explicitProject ? `status ${explicitProject}` : "status"
    };
  }

  if (
    /\b(details|did (that|it) work|what happened|show (me )?(the )?(result|details)|latest result|how did (that|it) go)\b/i.test(normalized)
  ) {
    if (explicitProject && state.lastProject && explicitProject !== state.lastProject) {
      return {
        kind: "clarify",
        reply: `The latest recorded run is for ${state.lastProject.toUpperCase()}, not ${explicitProject.toUpperCase()}. Ask for status ${explicitProject}, or give me the run ID you want inspected.`
      };
    }
    return {
      kind: "immediate",
      canonicalCommand: explicitProject ? `details ${explicitProject}` : "details"
    };
  }

  if (hasAffirmativeStopIntent(sourceText)) {
    if (!state.lastRunId || !project) {
      return {
        kind: "clarify",
        reply: "I do not have a recorded run to stop. Give me the run ID or start from a project-specific request."
      };
    }
    if (explicitProject && state.lastProject && explicitProject !== state.lastProject) {
      return {
        kind: "clarify",
        reply: `The latest recorded run is for ${state.lastProject.toUpperCase()}, so I will not infer a ${explicitProject.toUpperCase()} stop target. Give me the exact run ID.`
      };
    }
    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: `stop ${state.lastRunId}`,
        action: "stop",
        project,
        createdAt: new Date().toISOString()
      }
    };
  }

  const cleanDirtyTreeIntent =
    /\bclean\b/i.test(normalized) &&
    /\bdirty\b/i.test(normalized) &&
    /\b(tree|working|worktree)\b/i.test(normalized);

  if (cleanDirtyTreeIntent) {
    if (!project) {
      return {
        kind: "clarify",
        reply: "Which project should I clean: PRYSM, GACM, or sandbox?"
      };
    }

    const safeObjective = [
      "Clean the current dirty working tree so governed work can continue.",
      "Diagnose every dirty entry before changing anything.",
      "Remove only clearly generated/cache/build artifacts that are safe to delete and are not intentional project work (for example __pycache__ directories and .pyc files when applicable).",
      "Do not delete, overwrite, reset, checkout, stash, or otherwise alter tracked changes or ambiguous/untracked project work.",
      "If any dirty entry may be intentional or its authority is unclear, stop and report it as a blocker instead of removing it.",
      "After cleanup, verify the working tree state, current branch and SHA, and report RESULT, BLOCKER, and NEXT ACTION.",
      "Do not commit, push, merge, switch branches, touch main, deploy, or modify production."
    ].join(" ");

    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: `run ${project} TREE-CLEAN :: ${safeObjective}`,
        action: "run",
        project,
        tranche: "TREE-CLEAN",
        createdAt: new Date().toISOString()
      }
    };
  }

  if (hasAffirmativePublishIntent(sourceText)) {
    if (project !== "sandbox") {
      return {
        kind: "clarify",
        reply: "Conversational publish is currently authorized only for the sandbox. PRYSM/GACM push remains prohibited."
      };
    }
    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: "publish sandbox :: Telegram governed publish",
        action: "publish",
        project: "sandbox",
        createdAt: new Date().toISOString()
      }
    };
  }

  const changeIntent = hasAffirmativeChangeIntent(sourceText);

  if (changeIntent) {
    if (!project) {
      return {
        kind: "clarify",
        reply: "Which project should I apply that to: PRYSM, GACM, or sandbox?"
      };
    }

    const tranche = deriveTrancheLabel(sourceText);
    if (project === "prysm") {
      return { kind: "clarify", reply: "PRYSM runs require an explicit branch and full 40-character SHA. Use: run prysm <branch> <full-sha> <tranche> :: <objective>." };
    }
    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: `run ${project} ${tranche} :: ${sourceText}`,
        action: "run",
        project,
        tranche,
        createdAt: new Date().toISOString()
      }
    };
  }

  if (lower === "yes" || lower === "no") {
    return {
      kind: "clarify",
      reply: "There is no pending proposal to confirm."
    };
  }

  return {
    kind: "clarify",
    reply:
      "I could not safely turn that into a governed action. Mention PRYSM, GACM, or sandbox and tell me what you want to check, change, run, stop, or verify.",
    allowLlmFallback: true
  };
}

function proposalReply(proposal: PendingProposal): string {
  return [
    "I interpreted that as:",
    `Project: ${proposal.project.toUpperCase()}`,
    `Action: ${proposal.action.toUpperCase()}`,
    proposal.tranche ? `Tranche: ${proposal.tranche}` : "",
    "",
    "Canonical command:",
    proposal.canonicalCommand,
    "",
    "Nothing has run yet.",
    "Reply YES to execute this exact command, or NO to cancel."
  ].filter(Boolean).join("\n");
}

function projectFromRunId(runId: string): ProjectKey | null {
  if (runId.startsWith("prysm-")) return "prysm";
  if (runId.startsWith("gacm-")) return "gacm";
  if (runId.startsWith("sandbox-")) return "sandbox";
  return null;
}

function sanitizeTranche(value: string | null, sourceText: string): string {
  const candidate = value?.trim();
  if (candidate && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) {
    return candidate.toUpperCase();
  }
  return deriveTrancheLabel(sourceText);
}

function interpretationFromLlm(
  intent: LlmIntent,
  sourceText: string,
  state: ControllerState
): NaturalInterpretation {
  if (intent.confidence < 0.82) {
    return {
      kind: "clarify",
      reply:
        intent.clarification?.trim() ||
        "I am not confident enough to act on that. Please restate it with the project and what you want me to do."
    };
  }

  if (intent.action === "clarify") {
    return {
      kind: "clarify",
      reply:
        intent.clarification?.trim() ||
        "I need a little more detail before I can turn that into a governed action."
    };
  }

  if (intent.action === "status") {
    return {
      kind: "immediate",
      canonicalCommand: intent.project ? `status ${intent.project}` : "status"
    };
  }

  if (intent.action === "details") {
    if (intent.run_id) {
      return { kind: "immediate", canonicalCommand: `details ${intent.run_id}` };
    }
    return {
      kind: "immediate",
      canonicalCommand: intent.project ? `details ${intent.project}` : "details"
    };
  }

  if (intent.action === "stop") {
    const targetRunId =
      intent.run_id ||
      (intent.project && state.lastProject === intent.project ? state.lastRunId : undefined) ||
      (!intent.project ? state.lastRunId : undefined);

    if (!targetRunId) {
      return {
        kind: "clarify",
        reply: "I could not determine which run you want stopped. Give me the project or exact run ID."
      };
    }

    const runProject = projectFromRunId(targetRunId);
    if (!runProject) {
      return {
        kind: "clarify",
        reply: "That run ID is not one of the governed PRYSM, GACM, or sandbox run IDs."
      };
    }

    if (intent.project && intent.project !== runProject) {
      return {
        kind: "clarify",
        reply: `The requested project (${intent.project.toUpperCase()}) does not match run ${targetRunId}.`
      };
    }

    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: `stop ${targetRunId}`,
        action: "stop",
        project: runProject,
        createdAt: new Date().toISOString()
      }
    };
  }

  if (intent.action === "publish") {
    if (intent.project !== "sandbox") {
      return {
        kind: "clarify",
        reply: "Publish is authorized only for the sandbox. PRYSM/GACM push remains prohibited."
      };
    }
    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: "publish sandbox :: Telegram governed publish",
        action: "publish",
        project: "sandbox",
        createdAt: new Date().toISOString()
      }
    };
  }

  if (intent.action === "run") {
    if (!intent.project) {
      return {
        kind: "clarify",
        reply: "Which project should I apply that to: PRYSM, GACM, or sandbox?"
      };
    }

    const tranche = sanitizeTranche(intent.tranche, sourceText);
    if (intent.project === "prysm") {
      return {
        kind: "clarify",
        reply: "PRYSM runs require an explicit branch and full 40-character SHA. Use: run prysm <branch> <full-sha> <tranche> :: <objective>."
      };
    }
    return {
      kind: "proposal",
      proposal: {
        sourceText,
        canonicalCommand: `run ${intent.project} ${tranche} :: ${sourceText}`,
        action: "run",
        project: intent.project,
        tranche,
        createdAt: new Date().toISOString()
      }
    };
  }

  return {
    kind: "clarify",
    reply: "I could not safely validate the interpreted action."
  };
}

export function helpText(): string {
  return [
    "Commands:",
    "status",
    "status prysm",
    "status gacm",
    "status sandbox",
    "details [run-id]",
    "stop [run-id]",
    "run <gacm|sandbox> <tranche> :: <objective>",
    "run prysm <branch> <full-sha> <tranche> :: <objective>",
    "continue <tranche> :: <objective> (PRYSM requires branch + full SHA)",
    "publish sandbox :: <commit message>",
    "",
    "You can also speak normally. Free text is converted into a canonical command and shown to you first. Mutating actions require YES before execution."
  ].join("\n");
}

export async function handleCommand(
  rawText: string,
  state: ControllerState,
  deps: ControllerDeps = defaultDeps
): Promise<CommandResult> {
  const text = normalizeCommand(rawText);
  if (!text) return { reply: helpText() };

  const confirmation = text.toLowerCase();
  if (state.pendingProposal && ["yes", "confirm", "execute", "go ahead", "do it", "proceed"].includes(confirmation)) {
    const proposal = state.pendingProposal;
    const clearedState: ControllerState = { ...state, pendingProposal: undefined };
    const executed = await handleCommand(proposal.canonicalCommand, clearedState, deps);
    return {
      ...executed,
      state: executed.state ?? clearedState
    };
  }

  if (state.pendingProposal && ["no", "cancel", "do not execute", "don't execute"].includes(confirmation)) {
    return {
      reply: "Pending governed action cancelled. Nothing was executed.",
      state: { ...state, pendingProposal: undefined }
    };
  }

  if (state.pendingProposal) {
    const clearedState: ControllerState = { ...state, pendingProposal: undefined };
    const processed = await handleCommand(rawText, clearedState, deps);
    return {
      ...processed,
      state: processed.state ?? clearedState
    };
  }

  const [verbRaw, ...restParts] = text.split(/\s+/);
  const verb = verbRaw.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (verb === "help" || verb === "start") {
    return { reply: helpText() };
  }

  if (verb === "status") {
    if (rest) {
      const project = rest.toLowerCase();
      if (!isProject(project)) return { reply: "Unknown project. Use prysm, gacm, or sandbox." };
      const s = await deps.getProjectStatus(project);
      const lines = [
        project.toUpperCase(),
        `Branch: ${s.branch}`,
        `SHA: ${s.sha}`,
        `Working tree: ${s.dirty ? "DIRTY" : "CLEAN"}`,
        ...(project === "gacm" && s.authority ? [
          `GACM_GOVERNANCE: ${s.authority.governance.root} | ${s.authority.governance.authoritativeRef} | ${s.authority.governance.authoritativeSha} | ${s.authority.governance.available ? "AVAILABLE" : "UNAVAILABLE"}`,
          `GACM_APPLICATION: ${s.authority.application.root} | ${s.authority.application.authoritativeRef} | ${s.authority.application.authoritativeSha} | ${s.authority.application.available ? "AVAILABLE" : "UNAVAILABLE"}`,
          `Foundation 13: ${s.authority.foundation13}`
        ] : []),
        s.porcelain ? `Changes:\n${compact(s.porcelain, 1200)}` : ""
      ].filter(Boolean);

      if (state.lastProject === project && state.lastRunId) {
        try {
          const run = await deps.getCodexTail(state.lastRunId, 700);
          lines.push(
            `Latest run: ${run.status.runId}`,
            `Run state: ${run.status.state}`
          );
        } catch (error) {
          if (error instanceof RunStatusReadError) {
            const label = error.diagnostic === "HISTORICAL_SOURCE_MISMATCH"
              ? "historical status unavailable (UNVERIFIED)"
              : error.diagnostic === "UNAVAILABLE"
                ? "unavailable (UNAVAILABLE)"
                : `${error.diagnostic.toLowerCase()} (UNVERIFIED)`;
            lines.push(`Latest run: ${error.runId}`, `Run state: ${label}`, `Diagnostic: ${error.reason}`);
          } else {
            lines.push(`Latest run: ${state.lastRunId}`, "Run state: unavailable");
          }
        }
      }

      return { reply: lines.join("\n") };
    }

    const [prysm, gacm, sandbox] = await Promise.all([
      deps.getProjectStatus("prysm"),
      deps.getProjectStatus("gacm"),
      deps.getProjectStatus("sandbox")
    ]);
    const lines = [
      `PRYSM: ${prysm.branch} | ${prysm.sha.slice(0, 8)} | ${prysm.dirty ? "DIRTY" : "CLEAN"}`,
      `GACM: GOVERNANCE ${gacm.branch} | ${gacm.sha.slice(0, 8)} | ${gacm.dirty ? "DIRTY" : "CLEAN"}`,
      ...(gacm.authority ? [
        `GACM APPLICATION: ${gacm.authority.application.status?.branch || "(unavailable)"} | ${gacm.authority.application.status?.sha.slice(0, 8) || "(unavailable)"} | ${gacm.authority.application.status?.dirty ? "DIRTY" : "CLEAN"}`,
        `GACM F13: ${gacm.authority.foundation13}`
      ] : []),
      `SANDBOX: ${sandbox.branch} | ${sandbox.sha.slice(0, 8)} | ${sandbox.dirty ? "DIRTY" : "CLEAN"}`
    ];
    if (state.lastRunId) {
      try {
        const run = await deps.getCodexTail(state.lastRunId, 1000);
        lines.push(`Last run: ${run.status.runId} | ${run.status.state}`);
      } catch {
        lines.push(`Last run: ${state.lastRunId} | status unavailable`);
      }
    }
    return { reply: lines.join("\n") };
  }

  if (verb === "details") {
    let runId = rest || state.lastRunId;

    if (rest && isProject(rest.toLowerCase())) {
      const requestedProject = rest.toLowerCase() as ProjectKey;
      if (state.lastProject !== requestedProject || !state.lastRunId) {
        return {
          reply: `No recorded latest run is available for ${requestedProject.toUpperCase()} in this controller state. Ask for status ${requestedProject} or provide an exact run ID.`
        };
      }
      runId = state.lastRunId;
    }

    if (!runId) return { reply: "No run is recorded yet." };
    const result = await deps.getCodexTail(runId, 3500);
    return {
      reply: [
        `Run: ${result.status.runId}`,
        `Project: ${result.status.project}`,
        `State: ${result.status.state}`,
        `Tranche: ${result.status.tranche}`,
        `Model: ${result.status.model}`,
        result.status.exitCode === null ? "" : `Exit: ${result.status.exitCode}`,
        "",
        compact(result.final || result.stderrTail || result.stdoutTail || "(no output yet)", 3500)
      ].filter(Boolean).join("\n")
    };
  }

  if (verb === "stop") {
    if (!rest) {
      const runId = state.lastRunId;
      if (!runId) return { reply: "No run is recorded yet." };
      const stopped = await deps.cancelCodexRun(runId);
      return { reply: `Stop requested for ${runId}. Current state: ${stopped.state}.` };
    }

    const explicitRunId = /^(?:prysm|gacm|sandbox)-[A-Za-z0-9._-]+$/.test(rest);
    if (explicitRunId) {
      const stopped = await deps.cancelCodexRun(rest);
      return { reply: `Stop requested for ${rest}. Current state: ${stopped.state}.` };
    }

    // Anything else beginning with "stop" is conversational language, not a literal run ID.
    // Fall through to the natural-language / LLM interpretation path below.
  }

  if (verb === "run") {
    const match = rest.match(/^(prysm|gacm|sandbox)\s+([\s\S]+)$/i);
    if (!match) {
      return { reply: "Format: run <prysm|gacm|sandbox> <tranche> :: <objective>" };
    }
    const project = match[1].toLowerCase() as ProjectKey;
    const targeted = project === "prysm" ? parsePrysmTargetedInstruction(match[2]) : null;
    const bounded = targeted || splitBoundedInstruction(match[2]);
    if (!bounded) {
      return { reply: project === "prysm" ? "Format: run prysm <branch> <full-sha> <tranche> :: <objective>" : "Format: run <gacm|sandbox> <tranche> :: <objective>" };
    }
    const run = await deps.startCodexRun(project, bounded.objective, bounded.tranche, undefined, targeted ? { branch: targeted.branch, sha: targeted.sha } : undefined);
    const nextState = { ...state, lastRunId: run.runId, lastProject: project };
    return {
      reply: [
        "Governed run started.",
        `Project: ${project}`,
        `Tranche: ${bounded.tranche}`,
        `Run: ${run.runId}`,
        `Model: ${run.model}`
      ].join("\n"),
      state: nextState
    };
  }

  if (verb === "continue") {
    if (!state.lastProject) {
      return { reply: "No prior project context. Use run <prysm|gacm|sandbox> <tranche> :: <objective>." };
    }
    const targeted = state.lastProject === "prysm" ? parsePrysmTargetedInstruction(rest) : null;
    const bounded = targeted || splitBoundedInstruction(rest);
    if (!bounded) {
      return { reply: state.lastProject === "prysm" ? "Format: continue <branch> <full-sha> <tranche> :: <objective>" : "Format: continue <tranche> :: <objective>" };
    }
    const run = await deps.startCodexRun(state.lastProject, bounded.objective, bounded.tranche, undefined, targeted ? { branch: targeted.branch, sha: targeted.sha } : undefined);
    const nextState = { ...state, lastRunId: run.runId };
    return {
      reply: [
        "Governed follow-up started.",
        `Project: ${state.lastProject}`,
        `Tranche: ${bounded.tranche}`,
        `Run: ${run.runId}`,
        `Model: ${run.model}`
      ].join("\n"),
      state: nextState
    };
  }

  if (verb === "publish") {
    const match = rest.match(/^sandbox\s*::\s*(.+)$/i);
    if (!match) {
      return { reply: "Format: publish sandbox :: <commit message>" };
    }
    if (state.lastProject !== "sandbox" || !state.lastRunId) {
      return { reply: "Publish requires a recorded COMPLETE sandbox run." };
    }

    const published = await deps.publishSandboxRun(state.lastRunId, match[1].trim());
    return {
      reply: [
        "Sandbox published to GitHub.",
        `Run: ${published.runId}`,
        `Branch: ${published.branch}`,
        `SHA: ${published.localSha}`,
        `Remote parity: ${published.remoteParity ? "PASS" : "FAIL"}`,
        `Working tree: ${published.clean ? "CLEAN" : "DIRTY"}`
      ].join("\n")
    };
  }

  const interpreted = interpretNaturalLanguage(rawText, state);

  if (interpreted.kind === "immediate") {
    return handleCommand(interpreted.canonicalCommand, state, deps);
  }

  if (interpreted.kind === "proposal") {
    const nextState: ControllerState = {
      ...state,
      pendingProposal: interpreted.proposal
    };
    return {
      reply: proposalReply(interpreted.proposal),
      state: nextState
    };
  }

  if (interpreted.allowLlmFallback) {
    try {
      const llmIntent = await deps.interpretWithLlm(rawText, {
        lastProject: state.lastProject,
        lastRunId: state.lastRunId
      });
      const llmInterpreted = interpretationFromLlm(llmIntent, rawText, state);

      if (llmInterpreted.kind === "immediate") {
        return handleCommand(llmInterpreted.canonicalCommand, state, deps);
      }

      if (llmInterpreted.kind === "proposal") {
        const nextState: ControllerState = {
          ...state,
          pendingProposal: llmInterpreted.proposal
        };
        return {
          reply: [
            "LLM fallback interpretation:",
            proposalReply(llmInterpreted.proposal)
          ].join("\n")
          ,
          state: nextState
        };
      }

      return {
        reply: llmInterpreted.reply,
        state
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reply: [
          "I could not safely interpret that message.",
          "The deterministic parser did not understand it, and the LLM fallback failed closed.",
          `Interpreter error: ${compact(message, 500)}`,
          "Please restate the request with the project and what you want done."
        ].join("\n"),
        state
      };
    }
  }

  return {
    reply: interpreted.reply,
    state: state.pendingProposal
      ? { ...state, pendingProposal: undefined }
      : state
  };
}

function parseControllerState(value: unknown): ControllerState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Telegram controller state object");
  }
  const s = value as Record<string, unknown>;
  if (!Number.isSafeInteger(s.updateOffset) || (s.updateOffset as number) < 0 ||
      typeof s.initialized !== "boolean") {
    throw new Error("Invalid Telegram controller state offset/initialization");
  }
  if (s.lastRunId !== undefined &&
      (typeof s.lastRunId !== "string" || !/^(prysm|gacm|sandbox)-[A-Za-z0-9._-]+$/.test(s.lastRunId))) {
    throw new Error("Invalid Telegram controller last run identity");
  }
  if (s.lastProject !== undefined && !isProject(String(s.lastProject))) {
    throw new Error("Invalid Telegram controller last project");
  }
  const proposal = s.pendingProposal;
  if (proposal !== undefined) {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
      throw new Error("Invalid Telegram pending proposal");
    }
    const p = proposal as Record<string, unknown>;
    if (typeof p.sourceText !== "string" || typeof p.canonicalCommand !== "string" ||
        !["run", "stop", "publish"].includes(String(p.action)) ||
        !isProject(String(p.project)) || typeof p.createdAt !== "string" ||
        (p.tranche !== undefined && typeof p.tranche !== "string")) {
      throw new Error("Invalid Telegram pending proposal fields");
    }
  }
  return s as unknown as ControllerState;
}

export async function loadControllerState(): Promise<ControllerState> {
  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let names: string[];
    try {
      names = await readdir(RUNTIME_DIR);
    } catch (dirError) {
      if ((dirError as NodeJS.ErrnoException).code !== "ENOENT") throw dirError;
      names = [];
    }
    if (names.some((n) => n.startsWith(".telegram-controller-state-") && n.endsWith(".tmp"))) {
      throw new Error("Telegram controller state is missing with an orphaned atomic write; HOLD");
    }
    return { updateOffset: 0, initialized: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Corrupt Telegram controller state; HOLD without resetting polling offset");
  }
  return parseControllerState(parsed);
}

export async function saveControllerState(state: ControllerState): Promise<void> {
  const validated = parseControllerState(state);
  await mkdir(RUNTIME_DIR, { recursive: true });
  const tempPath = path.join(RUNTIME_DIR, `.telegram-controller-state-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(validated, null, 2) + "\n", {
      encoding: "utf8", flag: "wx", flush: true
    });
    await rename(tempPath, STATE_PATH);
  } finally {
    try { await unlink(tempPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number };
    text?: string;
  };
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000)
  });
  const json = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !json.ok) {
    const suffix = json.description ? `: ${json.description}` : "";
    throw new Error(`Telegram API ${method} failed: HTTP ${response.status}${suffix}`);
  }
  return json.result as T;
}

async function sendTelegram(token: string, chatId: number, text: string): Promise<void> {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: compact(text, 3900)
  });
}

export async function runTelegramController(): Promise<void> {
  const token = process.env.TELEGRAM_CONTROL_BOT_TOKEN || "";
  const allowedChatId = Number(process.env.TELEGRAM_ALLOWED_CHAT_ID || "0");
  if (!token) throw new Error("TELEGRAM_CONTROL_BOT_TOKEN is not configured.");
  if (!Number.isSafeInteger(allowedChatId) || allowedChatId <= 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_ID is not configured.");
  }

  let state = await loadControllerState();

  if (!state.initialized) {
    for (;;) {
      const pending = await telegramApi<TelegramUpdate[]>(token, "getUpdates", {
        offset: state.updateOffset,
        timeout: 0,
        limit: 100,
        allowed_updates: ["message"]
      });
      if (pending.length === 0) break;
      for (const update of pending) {
        state.updateOffset = Math.max(state.updateOffset, update.update_id + 1);
      }
    }
    state.initialized = true;
    await saveControllerState(state);
  }

  let pollingErrorAlerted = false;

  for (;;) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>(token, "getUpdates", {
        offset: state.updateOffset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      pollingErrorAlerted = false;

      for (const update of updates) {
        state.updateOffset = Math.max(state.updateOffset, update.update_id + 1);
        const chatId = update.message?.chat?.id;
        const text = update.message?.text;
        if (chatId !== allowedChatId || !text) {
          await saveControllerState(state);
          continue;
        }

        try {
          const result = await handleCommand(text, state);
          if (result.state) state = result.state;
          state.updateOffset = Math.max(state.updateOffset, update.update_id + 1);
          await saveControllerState(state);
          await sendTelegram(token, allowedChatId, result.reply);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await saveControllerState(state);
          await sendManualNotification(
            "Telegram Controller",
            "ERROR",
            `ERROR: Telegram command could not be completed. ${message}`
          );
          await sendTelegram(token, allowedChatId, `ERROR: ${message}`);
        }
      }
      await saveControllerState(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        message.includes("aborted due to timeout") ||
        message.includes("TimeoutError") ||
        message.includes("The operation was aborted")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (message.includes("HTTP 409")) {
        await sendManualNotification(
          "Telegram Controller",
          "ERROR",
          "ERROR: Telegram control-bot polling conflict detected. Controller stopped instead of retrying."
        );
        throw error;
      }

      if (!pollingErrorAlerted) {
        await sendManualNotification(
          "Telegram Controller",
          "ERROR",
          `ERROR: Telegram controller polling failed. ${message}`
        );
        pollingErrorAlerted = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
