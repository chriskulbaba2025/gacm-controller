import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { executionBranchName, workspaceDirectoryName } from "./workspace-bootstrap.js";

const execFile = promisify(execFileCallback);
const prysmRoot = "C:\\g\\p001";
const longRunId = `prysm-${"x".repeat(400)}-PRYSM-COVERAGE-STATUS-001-${"y".repeat(400)}`;
const otherLongRunId = `${longRunId}-different`;

const workspaceName = workspaceDirectoryName(longRunId);
const otherWorkspaceName = workspaceDirectoryName(otherLongRunId);
const branchName = executionBranchName("PRYSM_PROJECT", longRunId);

assert.equal(workspaceName, workspaceDirectoryName(longRunId));
assert.notEqual(workspaceName, otherWorkspaceName);
assert.ok(workspaceName.length <= 22);
assert.ok(branchName.length <= 22);
assert.match(workspaceName, /^w-[0-9a-f]{20}$/);
assert.match(branchName, /^g-[0-9a-f]{20}$/);
assert.ok(path.join("C:\\g\\p", workspaceName).length < 40);
assert.ok(path.join("C:\\g\\p", `${workspaceName}-1`).length < 42);

const { stdout: porcelain } = await execFile("git", ["-C", prysmRoot, "status", "--porcelain=v1"], { windowsHide: true });
assert.equal(String(porcelain).trim(), "", "actual PRYSM checkout must remain clean");
const { stdout: tracked } = await execFile("git", ["-C", prysmRoot, "ls-files", "-z"], { windowsHide: true, maxBuffer: 20_000_000 });
const files = String(tracked).split("\0").filter(Boolean);
let deepest = 0;
for (const file of files) {
  const absolute = path.join(prysmRoot, file);
  deepest = Math.max(deepest, absolute.length);
  await lstat(absolute);
}

console.log(JSON.stringify({
  pass: true,
  actualRepository: prysmRoot,
  trackedFiles: files.length,
  deepestTrackedPathLength: deepest,
  zeroFilenameErrors: true,
  deterministic: true,
  collisionResistant: workspaceName !== otherWorkspaceName,
  recoverySuffixBounded: true
}));
