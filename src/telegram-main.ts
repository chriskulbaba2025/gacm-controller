import net from "node:net";
import { runTelegramController } from "./telegram-controller.js";

const LOCK_HOST = "127.0.0.1";
const LOCK_PORT = 49831;

async function acquireSingleInstanceLock(): Promise<net.Server> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LOCK_PORT, LOCK_HOST, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  return server;
}

async function main(): Promise<void> {
  let lock: net.Server;
  try {
    lock = await acquireSingleInstanceLock();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.error("Telegram controller already running; second instance refused.");
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    await runTelegramController();
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
