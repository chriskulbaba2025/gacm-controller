import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { startCodexRun, getStartCodexRunTestState } from "./core.js";

const execFileAsync = promisify(execFile);
const proofPrefix = "C:\\Users\\kulba\\Downloads\\TELEGRAM-CONTROL-SANDBOX-RUNS";
let childPid: number | null = null;
let promptBytes = 0;

function inertSpawn(): ChildProcess {
  const script = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "process.stdin.on('data',b=>process.stdout.write('PROMPT_RECEIVED\\n'));",
    "setInterval(()=>{},1000);"
  ].join("");
  const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  childPid = child.pid ?? null;
  child.stdin?.on("data", (chunk) => { promptBytes += Buffer.byteLength(String(chunk)); });
  return child;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

const before = getStartCodexRunTestState();
let errorText = "";
try {
  await startCodexRun(
    "sandbox",
    "INERT ACCEPTANCE: this child must never receive this prompt.",
    "GACM-TELEGRAM-ACTIVATION-001-R1",
    undefined,
    undefined,
    {
      spawn: inertSpawn,
      persistRunStatus: async () => { throw new Error("INJECTED SQLITE PERSISTENCE FAILURE"); }
    }
  );
} catch (error) {
  errorText = error instanceof Error ? error.message : String(error);
}

await new Promise((resolve) => setTimeout(resolve, 1000));
const after = getStartCodexRunTestState();
const childAlive = childPid === null ? false : await processExists(childPid);

assert.match(errorText, /Codex prompt withheld because SQLite persistence failed/);
assert.equal(promptBytes, 0, "prompt must not reach inert child");
assert.equal(childAlive, false, "inert child must be terminated");
assert.deepEqual(after, before, "active run/process registration must clear");

console.log(JSON.stringify({
  pass: true,
  errorText,
  childPid,
  childAlive,
  promptBytes,
  activeBefore: before,
  activeAfter: after,
  proofPrefix,
  falsePass: true
}, null, 2));
