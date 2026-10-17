import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gacm-s3-state-test-"));
  try {
    process.chdir(fixture);
    const { loadControllerState, saveControllerState } = await import("./telegram-controller.js");
    const stateFile = path.join(fixture, "runtime", "telegram-controller-state.json");
    assert.deepEqual(await loadControllerState(), { updateOffset: 0, initialized: false });
    const state = { updateOffset: 734, initialized: true,
      lastRunId: "prysm-20261017T171507679Z-PRYSM-MVP-SINGLE-BATCH-20261017-02-a1a329",
      lastProject: "prysm" as const };
    await saveControllerState(state);
    assert.deepEqual(await loadControllerState(), state);
    const stored = await readFile(stateFile, "utf8");
    assert.equal(JSON.parse(stored).updateOffset, 734);
    assert.equal((await readdir(path.dirname(stateFile))).filter((n) => n.endsWith(".tmp")).length, 0);

    await assert.rejects(saveControllerState({ ...state, updateOffset: -1 }), /Invalid Telegram controller state/);
    assert.equal(await readFile(stateFile, "utf8"), stored);
    await writeFile(stateFile, "{bad-json", "utf8");
    await assert.rejects(loadControllerState(), /Corrupt Telegram controller state/);
    assert.equal(await readFile(stateFile, "utf8"), "{bad-json");

    await writeFile(stateFile, JSON.stringify({ ...state, updateOffset: "bad" }), "utf8");
    await assert.rejects(loadControllerState(), /Invalid Telegram controller state/);
    await rm(stateFile);
    await mkdir(path.dirname(stateFile), { recursive: true });
    const orphan = path.join(path.dirname(stateFile), ".telegram-controller-state-orphan.tmp");
    await writeFile(orphan, "partial", "utf8");
    await assert.rejects(loadControllerState(), /orphaned atomic write/);
    await rm(orphan);
    assert.deepEqual(await loadControllerState(), { updateOffset: 0, initialized: false });
    console.log(JSON.stringify({ pass: true, persistedOffsetOnRestart: true,
      corruptFailsClosed: true, malformedFailsClosed: true,
      failedValidationPreservesEvidence: true, orphanedWriteFailsClosed: true,
      noResidualTemp: true, providerCalls: 0, codexLaunches: 0 }));
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
