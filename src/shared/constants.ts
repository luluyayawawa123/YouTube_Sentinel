export const DEFAULT_PORT = 42777;
export const DEFAULT_SETTINGS = {
  monitor: {
    intervalMinutes: 15,
    workWindow: {
      enabled: false,
      start: "08:00",
      end: "23:00"
    }
  },
  ai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini"
  },
  telegram: {
    botToken: "",
    chatId: ""
  },
  history: {
    retentionDays: 365 * 3
  },
  ui: {
    showChannelAvatars: false
  }
} as const;

export const HISTORY_CLEANUP_OPTIONS = [
  { label: "全部", days: 0 },
  { label: "保留最近 7 天", days: 7 },
  { label: "保留最近 1 个月", days: 30 },
  { label: "保留最近 3 个月", days: 90 },
  { label: "保留最近 1 年", days: 365 },
  { label: "保留最近 3 年", days: 1095 }
] as const;

export const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120] as const;
