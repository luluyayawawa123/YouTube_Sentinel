import type { TelegramSettings } from "@shared/types";

export async function sendTelegramMessage(settings: TelegramSettings, text: string): Promise<void> {
  if (!settings.botToken || !settings.chatId) {
    throw new Error("Telegram settings are incomplete");
  }

  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: settings.chatId,
      text,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}
