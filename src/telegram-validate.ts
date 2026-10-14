import "dotenv/config";

async function main() {
  const token = process.env.TELEGRAM_CONTROL_BOT_TOKEN || "";
  const chatId = Number(process.env.TELEGRAM_ALLOWED_CHAT_ID || "0");

  if (!token) throw new Error("TELEGRAM_CONTROL_BOT_TOKEN is not configured.");
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_ID is not configured.");
  }

  const call = async (method: string) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json() as {
      ok: boolean;
      result?: Record<string, unknown>;
      description?: string;
    };
    if (!response.ok || !body.ok) {
      throw new Error(body.description || `Telegram ${method} failed with HTTP ${response.status}`);
    }
    return body.result || {};
  };

  const me = await call("getMe");
  const webhook = await call("getWebhookInfo");
  const webhookUrl = typeof webhook.url === "string" ? webhook.url : "";

  console.log(JSON.stringify({
    pass: true,
    botUsername: me.username || null,
    botId: me.id || null,
    allowedChatIdConfigured: true,
    webhookConfigured: Boolean(webhookUrl),
    webhookHost: webhookUrl ? new URL(webhookUrl).host : null,
    pollingReady: !webhookUrl
  }, null, 2));

  if (webhookUrl) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
