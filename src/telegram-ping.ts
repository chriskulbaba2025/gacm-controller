import "dotenv/config";

async function main() {
  const token = process.env.TELEGRAM_CONTROL_BOT_TOKEN || "";
  const chatId = Number(process.env.TELEGRAM_ALLOWED_CHAT_ID || "0");
  if (!token || !Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error("Telegram token/chat ID not configured.");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Telegram controller is online. Reply with: status"
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json() as { ok: boolean; description?: string };
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram sendMessage failed.");
  console.log(JSON.stringify({ pass: true, messageSent: true }, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
