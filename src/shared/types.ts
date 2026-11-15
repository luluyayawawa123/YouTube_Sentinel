export type ApplyScope =
  | "immediate"
  | "next_poll"
  | "restart_worker"
  | "restart_ui";

export type WorkerStatus = "running" | "stopped" | "task_missing" | "task_registered";

export type DeliveryStatus = "success" | "failed";
export type ProcessState = "pending" | "processing" | "done" | "failed";
export type ContentLevel = "A" | "B" | "C";

export interface Channel {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  channelId: string;
  name: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastVideoAt: string | null;
  lastError: string | null;
  avatarPath: string | null;
  avatarUpdatedAt: string | null;
}

export interface VideoRecord {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
  sourceLevel: ContentLevel;
  processState: ProcessState;
}

export interface DeliveryRecord {
  id: string;
  videoId: string;
  tgStatus: DeliveryStatus;
  sentAt: string | null;
  retryCount: number;
  errorMessage: string | null;
  messagePreview: string;
}

export interface HistoryRecord {
  id: string;
  type: string;
  refId: string | null;
  channelId: string | null;
  title: string;
  status: string;
  summary: string;
  createdAt: string;
  expireAt: string;
}

export interface MonitorSettings {
  intervalMinutes: number;
  workWindow: {
    enabled: boolean;
    start: string;
    end: string;
  };
}

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TelegramSettings {
  botToken: string;
  chatId: string;
}

export interface UiSettings {
  showChannelAvatars: boolean;
}

export interface AppSettings {
  monitor: MonitorSettings;
  ai: AiSettings;
  telegram: TelegramSettings;
  ui: UiSettings;
}

export interface DashboardResponse {
  workerStatus: WorkerStatus;
  taskRegistered: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  workWindowLabel: string;
  lastRunAt: string | null;
  lastRunOutcome: string;
  channelCount: number;
  historyCount: number;
}

export interface DiagnosticStatus {
  name: string;
  status: "ok" | "error" | "timeout" | "unknown" | "running";
  detail: string;
  checkedAt: string;
  durationMs: number;
}

export interface LogRecord {
  id: string;
  source: "manual" | "scheduled" | "system";
  status: "info" | "success" | "error";
  message: string;
  createdAt: string;
}

export interface DiagnosticsResponse {
  items: DiagnosticStatus[];
  taskInfo: {
    registered: boolean;
    state: string;
    lastRunTime: string;
    lastResult: string;
  };
}

export interface YoutubeLoginStatus {
  cookies: "normal" | "unavailable" | "unknown";
  login: "logged_in" | "not_logged_in" | "verification_required" | "unknown";
  detail: string;
  checkedAt: string | null;
}

export interface FirefoxProfiles {
  profiles: Array<{ name: string; path: string; isDefault: boolean }>;
  selectedPath: string | null;
  automaticPath: string | null;
}

export type CleanupCategory = "push" | "execution" | "runtime" | "all";
export interface CleanupResult {
  history: number;
  deliveries: number;
  execution: number;
  textFiles: number;
  textLines: number;
  warnings: string[];
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
