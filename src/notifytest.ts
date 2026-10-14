import { sendManualNotification, webhookState } from "./core.js";

async function main() {
  if (!webhookState().configured) throw new Error("Webhook is not configured.");
  const result = await sendManualNotification(
    "MCP notification test",
    "WAITING_FOR_USER",
    "Generic workflow alert wiring test."
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== "SENT") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
