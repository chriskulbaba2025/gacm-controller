import {
  configuredModel,
  getGitDiff,
  getProjectStatus,
  readProjectFile,
  webhookState
} from "./core.js";

async function main() {
  const prysm = await getProjectStatus("prysm");
  const gacm = await getProjectStatus("gacm");
  const sandbox = await getProjectStatus("sandbox");

  if (!prysm.remoteParity || !gacm.remoteParity || !sandbox.remoteParity) {
    throw new Error("Remote identity parity failed.");
  }

  let escapeRejected = false;
  try {
    await readProjectFile("prysm", "..\\gacm-trial\\README.md");
  } catch {
    escapeRejected = true;
  }
  if (!escapeRejected) throw new Error("Path escape was not rejected.");

  const prysmDiff = await getGitDiff("prysm");
  const gacmDiff = await getGitDiff("gacm");
  const sandboxDiff = await getGitDiff("sandbox");

  console.log(JSON.stringify({
    pass: true,
    model: configuredModel(),
    webhook: webhookState(),
    prysm: {
      branch: prysm.branch,
      sha: prysm.sha,
      dirty: prysm.dirty,
      diffChars: prysmDiff.length
    },
    gacm: {
      branch: gacm.branch,
      sha: gacm.sha,
      dirty: gacm.dirty,
      diffChars: gacmDiff.length
    },
    sandbox: {
      branch: sandbox.branch,
      sha: sandbox.sha,
      dirty: sandbox.dirty,
      diffChars: sandboxDiff.length
    },
    pathEscapeRejected: escapeRejected
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
