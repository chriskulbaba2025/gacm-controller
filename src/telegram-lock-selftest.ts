import net from "node:net";
import { spawn } from "node:child_process";

const host = "127.0.0.1";
const port = 49831;

const holder = net.createServer();
await new Promise<void>((resolve, reject) => {
  holder.once("error", reject);
  holder.listen(port, host, () => resolve());
});

const child = spawn(process.execPath, ["--import", "tsx", "src/telegram-main.ts"], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (d) => { stdout += String(d); });
child.stderr?.on("data", (d) => { stderr += String(d); });

const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
await new Promise<void>((resolve) => holder.close(() => resolve()));

if (code !== 2 || !stderr.includes("second instance refused")) {
  console.error(JSON.stringify({ pass: false, code, stdout, stderr }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  pass: true,
  duplicateInstanceRefused: true,
  exitCode: code
}, null, 2));
