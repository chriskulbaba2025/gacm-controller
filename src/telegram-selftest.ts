import assert from "node:assert/strict";
import { handleCommand, type ControllerDeps, type ControllerState } from "./telegram-controller.js";

const calls: Array<Record<string, unknown>> = [];
const baseStatus = {
  root: "C:\\repo",
  topLevel: "C:\\repo",
  remote: "https://github.com/example/repo.git",
  expectedRemote: "https://github.com/example/repo.git",
  remoteParity: true,
  branch: "test-branch",
  sha: "1234567890abcdef",
  dirty: false,
  porcelain: ""
};

const deps: ControllerDeps = {
  async getProjectStatus(project) {
    calls.push({ fn: "status", project });
    return { ...baseStatus, project };
  },
  async getCodexTail(runId) {
    calls.push({ fn: "details", runId });
    return {
      status: {
        version: 1,
        controllerSource: {
          repositoryRoot: "C:\\controller",
          repositoryIdentity: "https://github.com/chriskulbaba2025/gacm-controller.git",
          branch: "test-branch",
          sha: "1234567890abcdef1234567890abcdef12345678",
          clean: true
        },
        runId,
        project: "prysm",
        tranche: "T1",
        objective: "test",
        model: "gpt-5.6-luna",
        state: "COMPLETE",
        pid: null,
        exitCode: 0,
        startedAt: "2026-10-04T00:00:00Z",
        finishedAt: "2026-10-04T00:01:00Z",
        proofDir: "C:\\proof",
        preRunSha: "abc",
        preRunDirty: false,
        terminalEvidence: "PROOF_PRESENT",
        productAcceptance: "HOLD",
        notification: "SENT"
      },
      stdoutTail: "",
      stderrTail: "",
      final: "RESULT: PASS"
    };
  },
  async cancelCodexRun(runId) {
    calls.push({ fn: "stop", runId });
    return {
      version: 1,
      controllerSource: {
        repositoryRoot: "C:\\controller",
        repositoryIdentity: "https://github.com/chriskulbaba2025/gacm-controller.git",
        branch: "test-branch",
        sha: "1234567890abcdef1234567890abcdef12345678",
        clean: true
      },
      runId,
      project: "prysm",
      tranche: "T1",
      objective: "test",
      model: "gpt-5.6-luna",
      state: "CANCELLED",
      pid: null,
      exitCode: null,
      startedAt: "2026-10-04T00:00:00Z",
      finishedAt: null,
      proofDir: "C:\\proof",
      preRunSha: "abc",
      preRunDirty: false,
      terminalEvidence: "NONE",
      productAcceptance: "HOLD",
      notification: "SUPPRESSED"
    };
  },
  async startCodexRun(project, objective, tranche, _gacmRole, prysmAuthorization) {
    calls.push({ fn: "run", project, objective, tranche, ...(prysmAuthorization ? { prysmAuthorization } : {}) });
    return {
      version: 1,
      controllerSource: {
        repositoryRoot: "C:\\controller",
        repositoryIdentity: "https://github.com/chriskulbaba2025/gacm-controller.git",
        branch: "test-branch",
        sha: "1234567890abcdef1234567890abcdef12345678",
        clean: true
      },
      runId: `${project}-test-run`,
      project,
      tranche,
      objective,
      model: "gpt-5.6-luna",
      state: "RUNNING",
      pid: 123,
      exitCode: null,
      startedAt: "2026-10-04T00:00:00Z",
      finishedAt: null,
      proofDir: "C:\\proof",
      preRunSha: "abc",
      preRunDirty: false,
      terminalEvidence: "NONE",
      productAcceptance: "HOLD",
      notification: "PENDING"
    };
  },
  async publishSandboxRun(runId, commitMessage) {
    calls.push({ fn: "publish", runId, commitMessage });
    return {
      runId,
      localSha: "fedcba9876543210",
      remoteSha: "fedcba9876543210",
      remoteParity: true,
      branch: "master",
      clean: true
    };
  },
  async interpretWithLlm(message, context) {
    calls.push({ fn: "llm", message, context });

    if (message === "what is the pulse on the gacm work right now") {
      return {
        project: "gacm",
        action: "status",
        tranche: null,
        objective: null,
        run_id: null,
        confidence: 0.96,
        clarification: null
      };
    }

    if (message === "sort out whatever is holding up gacm and report back") {
      return {
        project: "gacm",
        action: "run",
        tranche: "RECOVERY",
        objective: "Diagnose and address the current GACM blocker, then report the result.",
        run_id: null,
        confidence: 0.94,
        clarification: null
      };
    }

    if (message === "maybe do something with the current work") {
      return {
        project: "gacm",
        action: "run",
        tranche: null,
        objective: "Ambiguous request.",
        run_id: null,
        confidence: 0.45,
        clarification: "Do you want me to inspect the current GACM state or make a governed change?"
      };
    }

    if (message === "GACM: diagnose the current repository state read-only. Investigate the 1-ahead / 29-behind divergence and the two unproven tracked changes left by the failed run. Determine what should be preserved, discarded, or superseded and identify the authoritative Foundation 13 candidate. Do not modify files, reset, rebase, merge, switch branches, commit, push, or clean anything. Give me the safest exact next action.") {
      return {
        project: "gacm",
        action: "run",
        tranche: "F13-DIAGNOSIS",
        objective: "Read-only diagnosis of GACM divergence and unproven changes.",
        run_id: null,
        confidence: 0.98,
        clarification: null
      };
    }

    return {
      project: null,
      action: "clarify",
      tranche: null,
      objective: null,
      run_id: null,
      confidence: 0.99,
      clarification: "Which project and action do you want?"
    };
  }
};

async function main() {
  let state: ControllerState = { updateOffset: 0, initialized: true };

  const free = await handleCommand("please keep going", state, deps);
  assert.match(free.reply, /Which project and action do you want/i);
  assert.equal(calls.filter((x) => x.fn === "llm").length, 1);

  const llmReadOnly = await handleCommand(
    "what is the pulse on the gacm work right now",
    state,
    deps
  );
  assert.match(llmReadOnly.reply, /GACM/);
  assert.equal(
    calls.filter(
      (x) =>
        x.fn === "llm" &&
        x.message === "what is the pulse on the gacm work right now"
    ).length,
    1
  );

  const llmMutation = await handleCommand(
    "sort out whatever is holding up gacm and report back",
    state,
    deps
  );
  assert.match(llmMutation.reply, /LLM fallback interpretation/);
  assert.match(llmMutation.reply, /Project: GACM/);
  assert.match(llmMutation.reply, /Tranche: RECOVERY/);
  assert.match(
    llmMutation.reply,
    /run gacm RECOVERY :: sort out whatever is holding up gacm and report back/
  );
  assert.equal(
    calls.filter(
      (x) =>
        x.fn === "run" &&
        x.project === "gacm" &&
        x.tranche === "RECOVERY"
    ).length,
    0
  );

  const llmMutationConfirmed = await handleCommand("YES", llmMutation.state!, deps);
  assert.match(llmMutationConfirmed.reply, /Governed run started/);
  const llmRecoveryRun = calls.find(
    (x) => x.fn === "run" && x.project === "gacm" && x.tranche === "RECOVERY"
  );
  assert.deepEqual(llmRecoveryRun, {
    fn: "run",
    project: "gacm",
    objective: "sort out whatever is holding up gacm and report back",
    tranche: "RECOVERY"
  });

  const llmLowConfidence = await handleCommand(
    "maybe do something with the current work",
    { ...state, lastProject: "gacm" },
    deps
  );
  assert.match(llmLowConfidence.reply, /inspect the current GACM state or make a governed change/i);

  const llmCallsBeforeNegatedDiagnosis = calls.filter((x) => x.fn === "llm").length;
  const negatedPublishDiagnosis = await handleCommand(
    "GACM: diagnose the current repository state read-only. Investigate the 1-ahead / 29-behind divergence and the two unproven tracked changes left by the failed run. Determine what should be preserved, discarded, or superseded and identify the authoritative Foundation 13 candidate. Do not modify files, reset, rebase, merge, switch branches, commit, push, or clean anything. Give me the safest exact next action.",
    { ...state, lastProject: "gacm" },
    deps
  );
  assert.match(negatedPublishDiagnosis.reply, /I interpreted that as:/);
  assert.match(negatedPublishDiagnosis.reply, /Project: GACM/);
  assert.match(negatedPublishDiagnosis.reply, /Tranche: F13/);
  assert.match(negatedPublishDiagnosis.reply, /Do not modify files, reset, rebase, merge, switch branches, commit, push, or clean anything/);
  assert.doesNotMatch(negatedPublishDiagnosis.reply, /publish remains prohibited/i);
  assert.equal(
    calls.filter((x) => x.fn === "llm").length,
    llmCallsBeforeNegatedDiagnosis
  );

  const llmCallsBeforeSafetyReject = calls.filter((x) => x.fn === "llm").length;
  const prohibitedPublish = await handleCommand(
    "push GACM to github",
    { ...state, lastProject: "gacm" },
    deps
  );
  assert.match(prohibitedPublish.reply, /PRYSM\/GACM push remains prohibited/i);
  assert.equal(
    calls.filter((x) => x.fn === "llm").length,
    llmCallsBeforeSafetyReject
  );

  const naturalStopState: ControllerState = {
    updateOffset: 0,
    initialized: true,
    lastProject: "gacm",
    lastRunId: "gacm-current-run"
  };
  const stopCallsBefore = calls.filter((x) => x.fn === "stop").length;
  const naturalStopProposal = await handleCommand(
    "Stop the current GACM run",
    naturalStopState,
    deps
  );
  assert.match(naturalStopProposal.reply, /Project: GACM/);
  assert.match(naturalStopProposal.reply, /Action: STOP/);
  assert.match(naturalStopProposal.reply, /stop gacm-current-run/);
  assert.equal(
    calls.filter((x) => x.fn === "stop").length,
    stopCallsBefore
  );
  const naturalStopConfirmed = await handleCommand(
    "YES",
    naturalStopProposal.state!,
    deps
  );
  assert.match(naturalStopConfirmed.reply, /Stop requested for gacm-current-run/);
  assert.equal(
    calls.filter((x) => x.fn === "stop" && x.runId === "gacm-current-run").length,
    1
  );

  const conditionalStopRecovery = await handleCommand(
    "GACM: move ahead with the blocked Foundation 13 recovery. Archive the current dirty diffs and repository-state evidence outside the repo so nothing is lost. Then obtain and verify the exact authoritative Foundation 13 candidate df2ede96481f13905fe1dc9459a096cbebe329cc in a separate clean candidate context. Do not use the current dirty checkout as the candidate. Do not merge, rebase, transplant, commit, push, deploy, switch branches, or touch main. Stop if the exact candidate cannot be proven. When finished, tell me whether the candidate is verified, whether the failed-run residue and caches can safely be discarded, and the exact next action.",
    {
      updateOffset: 0,
      initialized: true,
      lastProject: "gacm",
      lastRunId: "gacm-blocked-run"
    },
    deps
  );
  assert.match(conditionalStopRecovery.reply, /Project: GACM/);
  assert.match(conditionalStopRecovery.reply, /Action: RUN/);
  assert.match(conditionalStopRecovery.reply, /Tranche: F13/);
  assert.match(conditionalStopRecovery.reply, /Stop if the exact candidate cannot be proven/);
  assert.doesNotMatch(conditionalStopRecovery.reply, /Action: STOP/);
  assert.doesNotMatch(conditionalStopRecovery.reply, /stop gacm-blocked-run/);

  const typoCleanText =
    "clean teh dirty workign tree wo we can move ahed, report when finished";
  const typoCleanState: ControllerState = {
    updateOffset: 0,
    initialized: true,
    lastProject: "gacm",
    lastRunId: "gacm-existing-run"
  };
  const typoCleanProposal = await handleCommand(typoCleanText, typoCleanState, deps);
  assert.match(typoCleanProposal.reply, /Project: GACM/);
  assert.match(typoCleanProposal.reply, /Tranche: TREE-CLEAN/);
  assert.match(typoCleanProposal.reply, /Remove only clearly generated\/cache\/build artifacts/);
  assert.equal(
    calls.filter((x) => x.fn === "run" && x.tranche === "TREE-CLEAN").length,
    0
  );

  const typoCleanConfirmed = await handleCommand("YES", typoCleanProposal.state!, deps);
  assert.match(typoCleanConfirmed.reply, /Governed run started/);
  const typoCleanCall = calls.find((x) => x.fn === "run" && x.tranche === "TREE-CLEAN");
  assert.equal(typoCleanCall?.project, "gacm");
  assert.match(String(typoCleanCall?.objective), /Diagnose every dirty entry/);
  assert.match(String(typoCleanCall?.objective), /Do not delete, overwrite, reset/);

  const naturalText =
    "GACM Foundation 13 passed. Move to Foundation 14, make the next governed changes, but don't touch main.";
  const naturalProposal = await handleCommand(naturalText, state, deps);
  assert.match(naturalProposal.reply, /Nothing has run yet/);
  assert.match(naturalProposal.reply, /Project: GACM/);
  assert.match(naturalProposal.reply, /Tranche: F14/);
  assert.match(
    naturalProposal.reply,
    /run gacm F14 :: GACM Foundation 13 passed\. Move to Foundation 14/
  );
  assert.equal(
    calls.filter((x) => x.fn === "run" && x.project === "gacm" && x.tranche === "F14").length,
    0
  );

  const confirmedNatural = await handleCommand("YES", naturalProposal.state!, deps);
  assert.match(confirmedNatural.reply, /Governed run started/);
  const naturalRunCall = calls.find(
    (x) => x.fn === "run" && x.project === "gacm" && x.tranche === "F14"
  );
  assert.deepEqual(naturalRunCall, {
    fn: "run",
    project: "gacm",
    objective: naturalText,
    tranche: "F14"
  });
  assert.equal(confirmedNatural.state?.pendingProposal, undefined);

  const cancelProposal = await handleCommand(
    "PRYSM: repair the current New Audit path, but do not touch production.",
    state,
    deps
  );
  assert.match(cancelProposal.reply, /explicit branch and full 40-character SHA/);
  const runCountBeforeCancel = calls.filter((x) => x.fn === "run").length;
  assert.equal(cancelProposal.state?.pendingProposal, undefined);
  assert.equal(calls.filter((x) => x.fn === "run").length, runCountBeforeCancel);

  const superseded = await handleCommand(
    "GACM Foundation 15: begin the next governed tranche.",
    state,
    deps
  );
  assert.ok(superseded.state?.pendingProposal);
  const supersedingStatus = await handleCommand(
    "what is the current state of GACM?",
    superseded.state!,
    deps
  );
  assert.match(supersedingStatus.reply, /GACM/);
  assert.equal(supersedingStatus.state?.pendingProposal, undefined);

  const screenshotState: ControllerState = {
    updateOffset: 0,
    initialized: true,
    lastProject: "gacm",
    lastRunId: "gacm-existing-run"
  };

  const explicitProjectDetails = await handleCommand("details gacm", screenshotState, deps);
  assert.match(explicitProjectDetails.reply, /RESULT: PASS/);

  const plainDetails = await handleCommand("details", screenshotState, deps);
  assert.match(plainDetails.reply, /RESULT: PASS/);

  const naturalProjectDetails = await handleCommand("GACM details", screenshotState, deps);
  assert.match(naturalProjectDetails.reply, /RESULT: PASS/);

  const naturalRunning = await handleCommand(
    "can you chek if GAM is running",
    screenshotState,
    deps
  );
  assert.match(naturalRunning.reply, /GACM/);
  assert.match(naturalRunning.reply, /Run state: COMPLETE/);

  const status = await handleCommand("status", state, deps);
  assert.match(status.reply, /PRYSM:/);
  assert.match(status.reply, /GACM:/);
  assert.match(status.reply, /SANDBOX:/);

  const sandboxStatus = await handleCommand("status sandbox", state, deps);
  assert.match(sandboxStatus.reply, /SANDBOX/);

  const badRun = await handleCommand("run prysm just do it", state, deps);
  assert.match(badRun.reply, /Format:/);

  const sandboxRun = await handleCommand(
    "run sandbox S-01 :: Create only a harmless sandbox proof file.",
    state,
    deps
  );
  assert.equal(sandboxRun.state?.lastProject, "sandbox");

  const publish = await handleCommand(
    "publish sandbox :: Telegram sandbox S-01",
    sandboxRun.state!,
    deps
  );
  assert.match(publish.reply, /Remote parity: PASS/);
  const publishCall = calls.find((x) => x.fn === "publish");
  assert.deepEqual(publishCall, {
    fn: "publish",
    runId: "sandbox-test-run",
    commitMessage: "Telegram sandbox S-01"
  });

  const badPublish = await handleCommand(
    "publish prysm :: must not publish",
    sandboxRun.state!,
    deps
  );
  assert.match(badPublish.reply, /Format:/);

  const run = await handleCommand("run prysm repair/prysm-evidence-accuracy-20261013 0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813 T-01 :: Repair only the authorized boundary.", state, deps);
  assert.equal(run.state?.lastProject, "prysm");
  assert.equal(run.state?.lastRunId, "prysm-test-run");
  state = run.state!;

  const runCall = calls.find((x) => x.fn === "run" && x.project === "prysm");
  assert.deepEqual(runCall, {
    fn: "run",
    project: "prysm",
    objective: "Repair only the authorized boundary.",
    tranche: "T-01",
    prysmAuthorization: {
      branch: "repair/prysm-evidence-accuracy-20261013",
      sha: "0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813"
    }
  });

  const follow = await handleCommand("continue repair/prysm-evidence-accuracy-20261013 0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813 T-02 :: Run the next explicitly authorized check.", state, deps);
  assert.equal(follow.state?.lastProject, "prysm");

  const details = await handleCommand("details", follow.state!, deps);
  assert.match(details.reply, /RESULT: PASS/);

  const stopped = await handleCommand("stop", follow.state!, deps);
  assert.match(stopped.reply, /Stop requested/);

  console.log(JSON.stringify({
    pass: true,
    freeTextFailsClosed: true,
    boundedRunRequired: true,
    explicitProjectRun: true,
    explicitContinueBoundary: true,
    statusReadOnly: true,
    detailsReadOnly: true,
    stopScopedToRecordedRun: true,
    sandboxPublishExplicit: true,
    nonSandboxPublishRejected: true,
    typoTolerantDirtyTreeIntent: true,
    dirtyTreeFailsClosedOnAmbiguousWork: true,
    projectDetailsAlias: true,
    naturalProjectDetails: true,
    typoTolerantRunningCheck: true,
    llmFallbackReadOnly: true,
    llmFallbackMutationRequiresConfirmation: true,
    llmLowConfidenceFailsClosed: true,
    explicitSafetyRejectBypassesLlm: true,
    negatedRestrictionsDoNotTriggerActions: true,
    naturalStopUsesRecordedRun: true,
    conditionalStopRemainsRunGuardrail: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
