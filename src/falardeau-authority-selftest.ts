import assert from "node:assert/strict";
import { PROJECTS } from "./config.js";
import { assertAcceptedFalardeauRun, FALARDEAU_WORDPRESS_BASELINE } from "./falardeau-authority.js";

const cfg = PROJECTS.falardeau;
const appRemote = "https://github.com/chriskulbaba2025/falardeau-astro-sanity.git";
const sampleSha = "0123456789abcdef0123456789abcdef01234567";
const sampleStatus = { branch: "main", sha: sampleSha, remote: appRemote, dirty: false };
const proposed = { ...cfg, authoritativeRef: "main", authoritativeSha: sampleSha };
const accepted = { branch: "main", sha: sampleSha };
function denied(fn: () => void, why: RegExp): void {
  assert.throws(fn, why);
}

assert.equal(FALARDEAU_WORDPRESS_BASELINE.repository, "chriskulbaba2025/falardeau-current-main");
assert.equal(FALARDEAU_WORDPRESS_BASELINE.sha, "d32a673daa85dd5c9ba7f1103ef1e7010311e0c7");
assert.equal(cfg.expectedRemote, appRemote);
assert.notEqual(cfg.expectedRemote, "https://github.com/chriskulbaba2025/falardeau-current-main.git");
assert.equal(cfg.authoritativeSha, undefined, "An uncreated Astro repo must never be implicitly activated.");
denied(() => assertAcceptedFalardeauRun(cfg, accepted, sampleStatus, "gpt-5.6-luna"), /NOT ACTIVATED/);
denied(() => assertAcceptedFalardeauRun(proposed, undefined, sampleStatus, "gpt-5.6-luna"), /branch\/SHA/);
denied(() => assertAcceptedFalardeauRun(proposed, { branch: "main", sha: "f".repeat(40) }, sampleStatus, "gpt-5.6-luna"), /branch\/SHA/);
denied(() => assertAcceptedFalardeauRun(proposed, accepted, { ...sampleStatus, dirty: true }, "gpt-5.6-luna"), /exact clean/);
denied(() => assertAcceptedFalardeauRun(proposed, accepted, { ...sampleStatus, branch: "unapproved" }, "gpt-5.6-luna"), /exact clean/);
denied(() => assertAcceptedFalardeauRun(proposed, accepted, { ...sampleStatus, sha: "f".repeat(40) }, "gpt-5.6-luna"), /exact clean/);
denied(() => assertAcceptedFalardeauRun(proposed, accepted, { ...sampleStatus, remote: "https://github.com/chriskulbaba2025/falardeau-current-main.git" }, "gpt-5.6-luna"), /origin mismatch/);
denied(() => assertAcceptedFalardeauRun(proposed, accepted, sampleStatus, "gpt-6"), /model authority failure/);
denied(() => assertAcceptedFalardeauRun({ ...proposed, key: "prysm" }, accepted, sampleStatus, "gpt-5.6-luna"), /requires Falardeau/);
assert.doesNotThrow(() => assertAcceptedFalardeauRun(proposed, accepted, sampleStatus, "gpt-5.6-luna"));
console.log("FAL-GACM-ONBOARD-001: dormant authority and negative-control fixtures PASS");
