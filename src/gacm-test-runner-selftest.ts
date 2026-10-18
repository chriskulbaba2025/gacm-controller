import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./core.ts", import.meta.url), "utf8");

assert.match(source, /normal test isolation by default/);
assert.match(source, /exact targeted command fails before test execution with Node \\`spawn EPERM\\`/);
assert.match(source, /--test-isolation=none/);
assert.match(source, /Do not use this fallback for other failures/);
assert.match(source, /report PASS only when the tests themselves exit 0/);

console.log("GACM Node test-runner fallback contract: PASS");
