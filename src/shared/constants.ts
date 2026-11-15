export const DEFAULT_PORT = 42777;
export const DIAGNOSTIC_NAMES = [
  "出口 IP / whatismyip", "出口 IP / dnsleaktest", "Google 连通性", "YouTube 连通性",
  "yt-dlp", "Deno 运行时", "YouTube 登录状态", "Firefox Cookies 读取"
] as const;
export const CLEANUP_CATEGORIES = [
  { value: "push", label: "推送记录", detail: "推送历史、发送结果及失败明细" },
  { value: "execution", label: "执行日志", detail: "手动巡检、定时巡检、推送及报错日志" },
  { value: "runtime", label: "文本运行日志", detail: "logs 目录中的启动及运行日志；无日期的内容会保留" },
  { value: "all", label: "全部记录与日志", detail: "以上三类一起清理" }
] as const;
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
  ui: {
    showChannelAvatars: false
  }
} as const;

export const CLEANUP_RANGE_OPTIONS = [
  { label: "清空全部", days: 0 },
  { label: "保留最近 7 天", days: 7 },
  { label: "保留最近 1 个月", days: 30 },
  { label: "保留最近 3 个月", days: 90 },
  { label: "保留最近 1 年", days: 365 },
  { label: "保留最近 3 年", days: 1095 }
] as const;

export const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120] as const;
