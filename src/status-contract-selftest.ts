import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  CONTROLLER_REPOSITORY_REMOTE,
  persistRunStatus,
  readPersistedRunStatus,
  type ControllerSourceIdentity,
  type StatusContractContext
} from "./status-contract.js";

const sha = "1234567890abcdef1234567890abcdef12345678";
const source: ControllerSourceIdentity = {
  repositoryRoot: "C:\\controller",
  repositoryIdentity: CONTROLLER_REPOSITORY_REMOTE,
  branch: "c1/status-integrity-20261014",
  sha,
  clean: true
};

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gacm-c1-status-"));
  try {
    const runId = "prysm-c1-status-contract";
    const proofDir = path.join(root, runId);
    const statusPath = path.join(proofDir, "status.json");
    const startedAt = "2026-10-14T00:00:00.000Z";
    const finishedAt = "2026-10-14T00:01:00.000Z";
    const workspaceAuthority = {
      runId,
      trancheId: "C1",
      repositoryRole: "PRYSM_PROJECT",
      repositoryRoot: "C:\\prysm",
      repositoryIdentity: "https://github.com/example/prysm.git",
      expectedRemote: "https://github.com/example/prysm.git",
      authoritativeRef: "main",
      authoritativeSha: sha,
      executionRoot: root,
      existingWorkspaceOnly: true
    };
    const workspaceBinding = {
      version: 2 as const,
      runId,
      trancheId: "C1",
      repositoryRole: "PRYSM_PROJECT",
      repositoryRoot: "C:\\prysm",
      repositoryIdentity: "https://github.com/example/prysm.git",
      expectedRemote: "https://github.com/example/prysm.git",
      authoritativeRef: "main",
      authoritativeSha: sha,
      workspacePath: root,
      executionBranch: "governed-prysm-test",
      createdAt: startedAt
    };
    const context: StatusContractContext = {
      controllerSource: source,
      runId,
      project: "prysm",
      proofDir,
      activeProcess: true,
      authority: {
        project: {
          role: "PRYSM_PROJECT",
          repositoryRoot: "C:\\prysm",
          expectedRemote: "https://github.com/example/prysm.git",
          observedRemote: "https://github.com/example/prysm.git",
          authoritativeRef: "main",
          authoritativeSha: sha,
          observedBranch: "main",
          observedSha: sha
        }
      }
    };
    const running = {
      version: 1 as const,
      controllerSource: source,
      runId,
      project: "prysm" as const,
      tranche: "C1",
      objective: "Validate durable status contract",
      model: "gpt-5.6-luna",
      state: "RUNNING" as const,
      pid: 123,
      exitCode: null,
      startedAt,
      finishedAt: null,
      proofDir,
      preRunSha: sha,
      preRunDirty: false,
      workspaceAuthority,
      workspaceBinding,
      terminalEvidence: "NONE" as const,
      productAcceptance: "HOLD" as const,
      notification: "NOT_CONFIGURED" as const
    };

    assert.equal(await persistRunStatus(statusPath, running, context), "WRITTEN");
    assert.equal((await readPersistedRunStatus(statusPath, context)).state, "RUNNING");
    const snapshot = async () => JSON.stringify(await readPersistedRunStatus(statusPath, context));
    const runningBytes = await snapshot();

    for (const mutation of [
      { objective: "changed objective" },
      { model: "different-model" },
      { startedAt: "2026-10-14T00:00:01.000Z" }
    ]) {
      await assert.rejects(
        persistRunStatus(statusPath, { ...running, ...mutation }, context),
        /different run identity/
      );
      assert.equal(await snapshot(), runningBytes);
    }
    await assert.rejects(
      persistRunStatus(statusPath, { ...running, productAcceptance: "VERIFIED" }, context),
      /invalid/
    );

    const completed = {
      ...running,
      state: "COMPLETE" as const,
      exitCode: 0,
      finishedAt,
      terminalEvidence: "PROOF_PRESENT" as const
    };
    assert.equal(await persistRunStatus(statusPath, completed, context), "WRITTEN");
    assert.equal(await persistRunStatus(statusPath, completed, context), "UNCHANGED");
    const terminalBytes = await snapshot();

    await assert.rejects(
      persistRunStatus(statusPath, { ...completed, state: "FAILED", exitCode: 1 }, context),
      /terminal status evidence/
    );
    assert.equal(await snapshot(), terminalBytes);

    const settingsDb = new DatabaseSync(path.join(proofDir, "status.sqlite"));
    assert.equal(String((settingsDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase(), "wal");
    assert.equal(Number((settingsDb.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous), 2);
    assert.equal(String((settingsDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toLowerCase(), "ok");
    settingsDb.close();

    const sqlitePath = path.join(proofDir, "status.sqlite");
    const beforeReadEntries = await readdir(proofDir);
    const beforeReadBytes = await readFile(sqlitePath);
    const beforeReadStat = await stat(sqlitePath);
    assert.equal((await readPersistedRunStatus(statusPath, context)).state, "COMPLETE");
    const afterReadEntries = await readdir(proofDir);
    const afterReadBytes = await readFile(sqlitePath);
    const afterReadStat = await stat(sqlitePath);
    assert.deepEqual(afterReadEntries, beforeReadEntries);
    assert.deepEqual(afterReadBytes, beforeReadBytes);
    assert.equal(afterReadStat.size, beforeReadStat.size);
    assert.equal(afterReadStat.mtimeMs, beforeReadStat.mtimeMs);
    assert.equal(afterReadStat.ctimeMs, beforeReadStat.ctimeMs);

    const walDir = path.join(root, "active-wal-read");
    const walPath = path.join(walDir, "status.json");
    const walContext = { ...context, proofDir: walDir };
    const walRunning = { ...running, proofDir: walDir };
    await persistRunStatus(walPath, walRunning, walContext);
    const walDb = new DatabaseSync(path.join(walDir, "status.sqlite"));
    walDb.exec("BEGIN IMMEDIATE; UPDATE run_status SET payload = payload || ' ' WHERE run_id = '" + runId + "';");
    const beforeActiveWalRead = await readdir(walDir);
    assert.ok(beforeActiveWalRead.includes("status.sqlite-wal"));
    assert.ok(beforeActiveWalRead.includes("status.sqlite-shm"));
    assert.equal((await readPersistedRunStatus(walPath, walContext)).state, "RUNNING");
    assert.deepEqual(await readdir(walDir), beforeActiveWalRead);
    walDb.exec("ROLLBACK");
    walDb.close();

    const missingReadDir = path.join(root, "missing-read");
    await mkdir(missingReadDir, { recursive: true });
    await assert.rejects(readPersistedRunStatus(path.join(missingReadDir, "status.json"), { ...context, proofDir: missingReadDir }), /unavailable/);
    assert.deepEqual(await readdir(missingReadDir), []);

    const schemaDir = path.join(root, "missing-schema");
    const schemaPath = path.join(schemaDir, "status.sqlite");
    await mkdir(schemaDir, { recursive: true });
    const emptyDb = new DatabaseSync(schemaPath);
    emptyDb.exec("PRAGMA journal_mode=WAL;");
    emptyDb.close();
    const beforeSchemaBytes = await readFile(schemaPath);
    const beforeSchemaEntries = await readdir(schemaDir);
    await assert.rejects(readPersistedRunStatus(path.join(schemaDir, "status.json"), { ...context, proofDir: schemaDir }), /schema is missing or incompatible/);
    assert.deepEqual(await readdir(schemaDir), beforeSchemaEntries);
    assert.deepEqual(await readFile(schemaPath), beforeSchemaBytes);

    const failureDir = path.join(root, "injected-write-failure");
    const failurePath = path.join(failureDir, "status.json");
    const failureContext = { ...context, proofDir: failureDir };
    const failureRunning = { ...running, proofDir: failureDir };
    const failureCompleted = { ...failureRunning, state: "COMPLETE" as const, exitCode: 0, finishedAt, terminalEvidence: "PROOF_PRESENT" as const };
    assert.equal(await persistRunStatus(failurePath, failureRunning, failureContext), "WRITTEN");
    const failureDb = new DatabaseSync(path.join(failureDir, "status.sqlite"));
    failureDb.exec("CREATE TRIGGER fail_status_update BEFORE UPDATE ON run_status BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;");
    failureDb.close();
    await assert.rejects(persistRunStatus(failurePath, failureCompleted, failureContext), /SQLite status persistence failed/);
    assert.equal((await readPersistedRunStatus(failurePath, failureContext)).state, "RUNNING");

    const lockedDir = path.join(root, "conflicting-writer");
    const lockedPath = path.join(lockedDir, "status.json");
    const lockedContext = { ...context, proofDir: lockedDir };
    const lockedRunning = { ...running, proofDir: lockedDir };
    const lockedCompleted = { ...lockedRunning, state: "COMPLETE" as const, exitCode: 0, finishedAt, terminalEvidence: "PROOF_PRESENT" as const };
    await persistRunStatus(lockedPath, lockedRunning, lockedContext);
    const lockDb = new DatabaseSync(path.join(lockedDir, "status.sqlite"));
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(persistRunStatus(lockedPath, lockedCompleted, lockedContext), /SQLite status persistence failed/);
    lockDb.exec("ROLLBACK");
    lockDb.close();
    assert.equal((await readPersistedRunStatus(lockedPath, lockedContext)).state, "RUNNING");

    const corruptPath = path.join(root, "corrupt", "status.json");
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(path.join(path.dirname(corruptPath), "status.sqlite"), "not a sqlite database", "utf8");
    await assert.rejects(readPersistedRunStatus(corruptPath, context), /SQLite status.*invalid or unreadable/);
    await assert.rejects(persistRunStatus(corruptPath, running, context), /SQLite status persistence failed/);

    const uncertainPath = path.join(root, "uncertain", "status.json");
    assert.equal(await persistRunStatus(uncertainPath, running, context), "WRITTEN");
    await assert.rejects(
      readPersistedRunStatus(uncertainPath, { ...context, activeProcess: false }),
      /uncertain/
    );

    await assert.rejects(
      readPersistedRunStatus(statusPath, { ...context, runId: "prysm-other-run" }),
      /invalid/
    );
    await assert.rejects(
      readPersistedRunStatus(statusPath, {
        ...context,
        controllerSource: { ...source, sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }
      }),
      /stale or mismatched/
    );

    await assert.rejects(
      persistRunStatus(statusPath, {
        ...running,
        workspaceBinding: { ...workspaceBinding, authoritativeRef: "stale-ref" }
      }, context),
      /different repository identities/
    );

    const unreadablePath = path.join(root, "unreadable-status");
    await mkdir(unreadablePath);
    await assert.rejects(readPersistedRunStatus(unreadablePath, context), /unreadable/);
    await assert.rejects(persistRunStatus(unreadablePath, running, context), /Legacy JSON status exists/);

    const legacyDir = path.join(root, "legacy");
    const legacyPath = path.join(legacyDir, "status.json");
    const legacyContext = { ...context, proofDir: legacyDir };
    const legacyRunning = { ...running, proofDir: legacyDir };
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyRunning), "utf8");
    assert.equal((await readPersistedRunStatus(legacyPath, legacyContext)).runId, runId);
    await assert.rejects(persistRunStatus(legacyPath, legacyRunning, legacyContext), /Legacy JSON status exists/);

    const failedDatabasePath = path.join(root, "failed-database", "status.json");
    await mkdir(path.dirname(failedDatabasePath), { recursive: true });
    await mkdir(path.join(path.dirname(failedDatabasePath), "status.sqlite"));
    await assert.rejects(persistRunStatus(failedDatabasePath, running, context), /SQLite status persistence failed/);

    await writeFile(`${statusPath}.orphan.tmp`, "orphaned temporary data", "utf8");
    assert.equal((await readPersistedRunStatus(statusPath, context)).runId, runId);
    assert.equal(await readFile(`${statusPath}.orphan.tmp`, "utf8"), "orphaned temporary data");

    const recoveryPath = path.join(root, "restart-recovery", "status.json");
    await mkdir(path.dirname(recoveryPath), { recursive: true });
    await writeFile(`${recoveryPath}.incomplete.tmp`, "{incomplete", "utf8");
    await assert.rejects(readPersistedRunStatus(recoveryPath, context), /unavailable/);
    assert.equal(await persistRunStatus(recoveryPath, completed, context), "WRITTEN");
    assert.equal(
      (await readPersistedRunStatus(recoveryPath, { ...context, activeProcess: false })).productAcceptance,
      "HOLD"
    );

    const governanceSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const applicationSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const governanceRoot = "C:\\gacm-governance";
    const applicationRoot = "C:\\gacm-application";
    const governanceRemote = "https://github.com/example/gacm-governance.git";
    const applicationRemote = "https://github.com/example/gacm-application.git";
    const governanceRef = "governance/foundation13";
    const applicationRef = "candidate/foundation13";
    const roleAuthority = (role: "GACM_GOVERNANCE" | "GACM_APPLICATION", rootPath: string, remote: string, ref: string, authoritativeSha: string, branch: string, observedSha: string) => ({
      role,
      root: rootPath,
      expectedRemote: remote,
      authoritativeRef: ref,
      authoritativeSha,
      acceptedBoundary: "FOUNDATION_13_ACCEPTED" as const,
      available: true,
      status: {
        project: "gacm" as const,
        root: rootPath,
        topLevel: rootPath,
        remote,
        expectedRemote: remote,
        remoteParity: true as const,
        branch,
        sha: observedSha,
        dirty: false,
        porcelain: ""
      }
    });
    const governanceAuthority = roleAuthority("GACM_GOVERNANCE", governanceRoot, governanceRemote, governanceRef, governanceSha, governanceRef, governanceSha);
    const applicationAuthority = roleAuthority("GACM_APPLICATION", applicationRoot, applicationRemote, applicationRef, applicationSha, applicationRef, applicationSha);
    const gacmAuthority = {
      governance: governanceAuthority,
      application: applicationAuthority,
      foundation13: "ACCEPTED" as const
    };
    const gacmContext = {
      controllerSource: source,
      runId: "gacm-c1-authority-test",
      project: "gacm" as const,
      proofDir: path.join(root, "gacm-authority"),
      activeProcess: true,
      authority: {
        gacm: {
          governance: {
            role: "GACM_GOVERNANCE",
            repositoryRoot: governanceRoot,
            expectedRemote: governanceRemote,
            observedRemote: governanceRemote,
            authoritativeRef: governanceRef,
            authoritativeSha: governanceSha,
            observedBranch: governanceRef,
            observedSha: governanceSha
          },
          application: {
            role: "GACM_APPLICATION",
            repositoryRoot: applicationRoot,
            expectedRemote: applicationRemote,
            observedRemote: applicationRemote,
            authoritativeRef: applicationRef,
            authoritativeSha: applicationSha,
            observedBranch: applicationRef,
            observedSha: applicationSha
          }
        }
      }
    };
    const makeGacmStatus = (role: "GACM_GOVERNANCE" | "GACM_APPLICATION") => {
      const selected = role === "GACM_GOVERNANCE" ? governanceAuthority : applicationAuthority;
      const run = `gacm-c1-${role === "GACM_GOVERNANCE" ? "governance" : "application"}`;
      const workspace = {
        runId: run,
        trancheId: "C1",
        repositoryRole: role,
        repositoryRoot: selected.root,
        repositoryIdentity: selected.expectedRemote,
        expectedRemote: selected.expectedRemote,
        authoritativeRef: selected.authoritativeRef,
        authoritativeSha: selected.authoritativeSha,
        executionRoot: root
      };
      const { executionRoot: _executionRoot, ...bindingIdentity } = workspace;
      return {
        version: 1 as const,
        controllerSource: source,
        runId: run,
        project: "gacm" as const,
        tranche: "C1",
        objective: "Validate GACM authority",
        model: "gpt-5.6-luna",
        state: "RUNNING" as const,
        pid: 456,
        exitCode: null,
        startedAt,
        finishedAt: null,
        proofDir: path.join(root, run),
        preRunSha: selected.authoritativeSha,
        preRunDirty: false,
        repositoryRole: role,
        authority: gacmAuthority,
        workspaceAuthority: workspace,
        workspaceBinding: {
          version: 2 as const,
          ...bindingIdentity,
          workspacePath: path.join(root, run),
          executionBranch: `governed-${role}`,
          createdAt: startedAt
        },
        terminalEvidence: "NONE" as const,
        productAcceptance: "HOLD" as const,
        notification: "NOT_CONFIGURED" as const
      };
    };
    const governanceStatus = makeGacmStatus("GACM_GOVERNANCE");
    const applicationStatus = makeGacmStatus("GACM_APPLICATION");
    const governanceContext = { ...gacmContext, runId: governanceStatus.runId, proofDir: governanceStatus.proofDir };
    const applicationContext = { ...gacmContext, runId: applicationStatus.runId, proofDir: applicationStatus.proofDir };
    assert.equal(await persistRunStatus(path.join(governanceStatus.proofDir, "status.json"), governanceStatus, governanceContext), "WRITTEN");
    assert.equal(await persistRunStatus(path.join(applicationStatus.proofDir, "status.json"), applicationStatus, applicationContext), "WRITTEN");

    const wrongRepository = {
      ...governanceStatus,
      authority: {
        ...gacmAuthority,
        governance: {
          ...governanceAuthority,
          expectedRemote: "https://github.com/example/wrong.git",
          status: { ...governanceAuthority.status, remote: "https://github.com/example/wrong.git", expectedRemote: "https://github.com/example/wrong.git" }
        }
      },
      workspaceAuthority: { ...governanceStatus.workspaceAuthority, repositoryIdentity: "https://github.com/example/wrong.git", expectedRemote: "https://github.com/example/wrong.git" },
      workspaceBinding: { ...governanceStatus.workspaceBinding, repositoryIdentity: "https://github.com/example/wrong.git", expectedRemote: "https://github.com/example/wrong.git" }
    };
    await assert.rejects(
      persistRunStatus(path.join(root, "wrong-repository", "status.json"), wrongRepository, governanceContext),
      /configured and independently observed/
    );
    await assert.rejects(
      persistRunStatus(path.join(root, "wrong-sha", "status.json"), {
        ...governanceStatus,
        authority: { ...gacmAuthority, governance: { ...governanceAuthority, authoritativeSha: applicationSha } },
        workspaceAuthority: { ...governanceStatus.workspaceAuthority, authoritativeSha: applicationSha },
        workspaceBinding: { ...governanceStatus.workspaceBinding, authoritativeSha: applicationSha }
      }, governanceContext),
      /configured and independently observed/
    );
    await assert.rejects(
      persistRunStatus(path.join(root, "wrong-foundation", "status.json"), {
        ...governanceStatus,
        authority: { ...gacmAuthority, foundation13: "F17_ACCEPTED" }
      }, governanceContext),
      /invalid/
    );

    console.log(JSON.stringify({
      pass: true,
      durableCreateAndRead: true,
      atomicTerminalTransition: true,
      duplicateWriteIsIdempotent: true,
      immutableRunningIdentityProtected: true,
      validTerminalEvidenceIsProtected: true,
      malformedAndCorruptRecordsRejected: true,
      unreadableEvidenceCannotBeReplaced: true,
      sqliteWriteFailurePreservesPriorEvidence: true,
      conflictingWriterRejected: true,
      legacyJsonPreservedWithoutMigration: true,
      uncertainRunningRecordRejected: true,
      staleAndMismatchedIdentityRejected: true,
      orphanedTempDoesNotReplaceValidRecord: true,
      incompleteTempRecoveryAfterRestart: true,
      productAcceptanceRemainsHold: true,
      readDoesNotMutateDatabase: true,
      activeWalReadDoesNotAddArtifacts: true,
      missingReadDoesNotCreateDatabase: true,
      missingSchemaFailsClosedWithoutInitialization: true,
      gacmGovernanceAuthorityPositive: true,
      gacmApplicationAuthorityPositive: true,
      gacmWrongRepositoryRejected: true,
      gacmWrongShaRejected: true,
      outdatedFoundationBoundaryRejected: true,
      providerCalls: 0,
      productionWrites: 0
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
