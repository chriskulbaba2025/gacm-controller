import { getCodexStatus, startCodexRun } from "./core.js";

async function main() {
  const run = await startCodexRun(
    "sandbox",
    "Create TEST-RESULT.txt containing a short confirmation that the governed Telegram control path executed successfully. Do not modify any other file.",
    "S-01"
  );

  console.log(JSON.stringify({ started: true, runId: run.runId, proofDir: run.proofDir }, null, 2));

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await getCodexStatus(run.runId);
    if (status.state !== "RUNNING") {
      console.log(JSON.stringify(status, null, 2));
      process.exitCode = status.state === "COMPLETE" ? 0 : 2;
      return;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
