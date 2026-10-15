import assert from "node:assert/strict";
import { assertPrysmAuthorityStatus } from "./core.js";

const base = {
  remote: "https://github.com/chriskulbaba2025/prysm-staging-isolated.git",
  expectedRemote: "https://github.com/chriskulbaba2025/prysm-staging-isolated.git",
  branch: "",
  sha: "0ad1f183d86a0f4b6c066a9ef8f3c96bb8350813",
  dirty: false
} as const;

assert.doesNotThrow(() => assertPrysmAuthorityStatus(base));
assert.doesNotThrow(() => assertPrysmAuthorityStatus({ ...base, branch: "repair/prysm-evidence-accuracy-20261013" }));
assert.throws(() => assertPrysmAuthorityStatus({ ...base, remote: "https://github.com/example/old.git" }), /origin/);
assert.throws(() => assertPrysmAuthorityStatus({ ...base, branch: "old-dirty-branch" }), /authorized ref/);
assert.throws(() => assertPrysmAuthorityStatus({ ...base, sha: "80191a6f10394e2803977f3d461c211039b4cfb6" }), /authorized SHA/);
assert.throws(() => assertPrysmAuthorityStatus({ ...base, dirty: true }), /dirty/);

console.log(JSON.stringify({
  pass: true,
  exactRepository: true,
  exactBranch: true,
  detachedExactSha: true,
  wrongRepositoryBlocked: true,
  wrongBranchBlocked: true,
  wrongShaBlocked: true,
  dirtyBlocked: true
}));
