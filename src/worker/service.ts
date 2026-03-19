import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { AppSettings, Channel, DiagnosticsResponse } from "@shared/types";
import { HISTORY_CLEANUP_OPTIONS } from "@shared/constants";
import { makeId } from "@shared/utils";
import type { RuntimePaths } from "@worker/runtime";
import { Storage } from "@worker/storage";
import { createAiBrief, testAiConnection } from "@worker/integrations/ai";
import { sendTelegramMessage } from "@worker/integrations/telegram";
import { fetchLatestTargetEntries, fetchSubtitleText, getVideoMetadata, resolveChannelInfo } from "@worker/integrations/ytdlp";

const execFileAsync = promisify(execFile);

export class WorkerService {
  constructor(
    private readonly storage: Storage,
    private readonly paths: RuntimePaths,
    private settings: AppSettings
  ) {}

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  async addOrUpdateChannel(input: { id?: string; originalUrl: string; name: string }): Promise<Channel> {
    const resolved = await resolveChannelInfo(this.paths, input.originalUrl);
    const existing = this.storage.getChannelByCanonical(resolved.channelId);
    if (existing && existing.id !== input.id) {
      throw new Error("该目标已存在");
    }

    const current = input.id ? this.storage.getChannel(input.id) : existing;
    const channel: Channel = {
      id: input.id ?? makeId("ch"),
      originalUrl: input.originalUrl,
      canonicalUrl: resolved.canonicalUrl,
      channelId: resolved.channelId,
      name: input.name || resolved.channelName,
      enabled: current?.enabled ?? true,
      lastCheckedAt: current?.lastCheckedAt ?? null,
      lastVideoAt: current?.lastVideoAt ?? null,
      lastError: current?.lastError ?? null,
      avatarPath: current?.avatarPath ?? null,
      avatarUpdatedAt: current?.avatarUpdatedAt ?? null
    };

    this.storage.upsertChannel(channel);
    return this.storage.getChannel(channel.id) ?? channel;
  }

  async syncAllChannels(source: "manual" | "scheduled" = "manual"): Promise<void> {
    const channels = this.storage.listChannels().filter((item) => item.enabled);
    let discoveredCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastOutcome = "\u6ca1\u6709\u542f\u7528\u7684\u76d1\u63a7\u76ee\u6807";

    this.writeLog(source, "info", `\u5f00\u59cb\u6267\u884c\u5168\u91cf\u5de1\u68c0\uff0c\u5171 ${channels.length} \u4e2a\u542f\u7528\u76ee\u6807\u3002`);

    for (const channel of channels) {
      try {
        const count = await this.syncSingleChannel(channel.id, source);
        if (count > 0) {
          discoveredCount += count;
        } else {
          unchangedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        const detail = error instanceof Error ? error.message : "\u5de1\u68c0\u5931\u8d25";
        this.writeLog(source, "error", `${channel.name}\uff1a${detail}`);
      }
    }

    if (channels.length === 0) {
      lastOutcome = "\u6ca1\u6709\u542f\u7528\u7684\u76d1\u63a7\u76ee\u6807";
    } else if (discoveredCount === 0 && failedCount === 0) {
      lastOutcome = `\u5df2\u68c0\u67e5 ${channels.length} \u4e2a\u76ee\u6807\uff0c\u6682\u65e0\u66f4\u65b0`;
    } else {
      lastOutcome = `\u5df2\u68c0\u67e5 ${channels.length} \u4e2a\u76ee\u6807\uff0c\u53d1\u73b0 ${discoveredCount} \u4e2a\u65b0\u89c6\u9891\uff0c${unchangedCount} \u4e2a\u65e0\u66f4\u65b0`;
      if (failedCount > 0) {
        lastOutcome += `\uff0c${failedCount} \u4e2a\u5931\u8d25`;
      }
    }

    this.storage.setRuntimeValue("lastRunAt", new Date().toISOString());
    this.storage.setRuntimeValue("lastRunOutcome", lastOutcome);
    this.storage.cleanupExpiredHistory();
    this.writeLog(
      source,
      channels.length === 0 ? "info" : failedCount > 0 ? "error" : "success",
      `\u672c\u8f6e\u5de1\u68c0\u7ed3\u675f\uff1a${lastOutcome}`
    );
  }

  async syncSingleChannel(channelId: string, source: "manual" | "scheduled" = "manual"): Promise<number> {
    const channel = this.storage.getChannel(channelId);
    if (!channel) {
      throw new Error("目标不存在");
    }

    this.writeLog(source, "info", `开始检查目标：${channel.name}`);

    const entries = await fetchLatestTargetEntries(this.paths, channel.originalUrl, 1);
    const latestEntry = entries[0];

    this.storage.updateChannelRuntime(channel.id, {
      lastCheckedAt: new Date().toISOString(),
      lastVideoAt: latestEntry?.publishedAt ?? channel.lastVideoAt,
      lastError: null
    });

    if (!latestEntry || this.storage.hasVideo(latestEntry.videoId)) {
      this.writeLog(source, "info", `${channel.name}：没有更新视频`);
      return 0;
    }

    await this.processVideo(channel, latestEntry);
    this.writeLog(source, "success", `${channel.name}：发现并处理了最新视频《${latestEntry.title}》`);
    return 1;
  }

  async testAi(): Promise<string> {
    return testAiConnection(this.settings.ai);
  }

  async testTelegram(): Promise<void> {
    await sendTelegramMessage(
      this.settings.telegram,
      "油管哨兵测试消息\n\n如果你能看到这条消息，说明 Telegram 推送已经打通。"
    );
  }

  cleanupHistoryByDays(days: number): void {
    const option = HISTORY_CLEANUP_OPTIONS.find((item) => item.days === days);
    if (!option) {
      throw new Error("不支持的清理范围");
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    this.storage.cleanupHistoryBefore(cutoff);
  }

  async clearAvatarCache(): Promise<number> {
    mkdirSync(this.paths.avatarsDir, { recursive: true });
    const files = readdirSync(this.paths.avatarsDir);
    for (const file of files) {
      rmSync(join(this.paths.avatarsDir, file), { force: true });
    }
    this.storage.clearChannelAvatars();
    return files.length;
  }

  async refreshAllChannelAvatars(): Promise<{ updated: number; failed: number; skipped: number }> {
    const channels = this.storage.listChannels();
    let updated = 0;
    let failed = 0;
    let skipped = 0;

    for (const channel of channels) {
      try {
        const resolved = await resolveChannelInfo(this.paths, channel.originalUrl);
        if (!resolved.avatarUrl) {
          skipped += 1;
          continue;
        }

        const ok = await this.refreshChannelAvatar(channel.id, resolved.avatarUrl);
        if (ok) {
          updated += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    this.writeLog("system", "info", `头像刷新完成：成功 ${updated}，失败 ${failed}，跳过 ${skipped}`);
    return { updated, failed, skipped };
  }

  getAvatarFile(channelId: string): { contentType: string; buffer: Buffer } | null {
    const channel = this.storage.getChannel(channelId);
    if (!channel?.avatarPath) {
      return null;
    }

    const filePath = join(this.paths.avatarsDir, channel.avatarPath);
    if (!existsSync(filePath)) {
      this.storage.updateChannelAvatar(channel.id, null, null);
      return null;
    }

    return {
      contentType: getContentTypeByExt(filePath),
      buffer: readFileSync(filePath)
    };
  }

  async getDiagnostics(): Promise<DiagnosticsResponse> {
    return {
      items: this.storage.getDiagnostics(),
      taskInfo: await getTaskInfo(this.paths.rootDir)
    };
  }

  async getTaskInfo(): Promise<DiagnosticsResponse["taskInfo"]> {
    return getTaskInfo(this.paths.rootDir);
  }

  async runDiagnostics(): Promise<DiagnosticsResponse> {
    const items = await Promise.all([
      diagnose("出口 IP / whatismyip", "https://www.whatismyip.com.tw"),
      diagnose("出口 IP / dnsleaktest", "https://www.dnsleaktest.com"),
      diagnose("Google 连通性", "https://www.google.com"),
      diagnose("YouTube 连通性", "https://www.youtube.com")
    ]);

    const response = { items, taskInfo: await getTaskInfo(this.paths.rootDir) };
    this.storage.saveDiagnostics(response);
    return response;
  }

  private async processVideo(
    channel: Channel,
    entry: {
      videoId: string;
      title: string;
      publishedAt: string;
      url: string;
    }
  ): Promise<void> {
    const metadata = await getVideoMetadata(this.paths, entry.url);
    let transcript = "";
    let sourceLevel: "A" | "B" | "C" = "C";

    if (metadata.subtitles.length > 0) {
      const preferred =
        metadata.subtitles.find((item) => item.lang.startsWith("zh")) ??
        metadata.subtitles.find((item) => item.lang.startsWith("en")) ??
        metadata.subtitles[0];

      try {
        transcript = await fetchSubtitleText(preferred);
        sourceLevel = "A";
      } catch {
        transcript = "";
      }
    }

    if (!transcript && (metadata.description || metadata.chapters?.length)) {
      sourceLevel = "B";
    }

    const brief = await createAiBrief(this.settings.ai, {
      channelName: channel.name,
      title: metadata.title,
      description: metadata.description,
      chapters: metadata.chapters?.map((item) => item.title) ?? [],
      transcript
    });

    const message = [
      `[${channel.name}] ${metadata.title}`,
      `发布时间：${metadata.publishedAt}`,
      `摘要：${brief.summary}`,
      "",
      ...brief.keyPoints.map((item, index) => `${index + 1}. ${item}`),
      "",
      `一句话结论：${brief.oneLineTakeaway}`,
      `置信度：${formatConfidenceLabel(brief.confidence)} / 来源等级 ${sourceLevel}`,
      metadata.webpageUrl
    ].join("\n");

    this.storage.addVideo({
      videoId: entry.videoId,
      channelId: channel.channelId,
      title: metadata.title,
      publishedAt: metadata.publishedAt,
      rawPayload: JSON.stringify(metadata),
      sourceLevel,
      processState: "processing"
    });

    try {
      await this.sendWithRetry(message);
      this.storage.updateVideoState(entry.videoId, "done", sourceLevel);
      this.storage.addDelivery({
        videoId: entry.videoId,
        tgStatus: "success",
        sentAt: new Date().toISOString(),
        retryCount: 0,
        errorMessage: null,
        messagePreview: message.slice(0, 200)
      });
      this.storage.addHistory({
        type: "delivery",
        refId: entry.videoId,
        channelId: channel.channelId,
        title: metadata.title,
        status: "success",
        summary: message.slice(0, 500),
        createdAt: new Date().toISOString(),
        expireAt: futureIso(this.settings.history.retentionDays)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知推送错误";
      this.storage.updateVideoState(entry.videoId, "failed", sourceLevel);
      this.storage.addDelivery({
        videoId: entry.videoId,
        tgStatus: "failed",
        sentAt: null,
        retryCount: 3,
        errorMessage: detail,
        messagePreview: message.slice(0, 200)
      });
      this.storage.addHistory({
        type: "delivery",
        refId: entry.videoId,
        channelId: channel.channelId,
        title: metadata.title,
        status: "failed",
        summary: detail,
        createdAt: new Date().toISOString(),
        expireAt: futureIso(this.settings.history.retentionDays)
      });
      throw error;
    }
  }

  private async sendWithRetry(text: string): Promise<void> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 3) {
      try {
        await sendTelegramMessage(this.settings.telegram, text);
        return;
      } catch (error) {
        attempt += 1;
        lastError = error;
        await wait(attempt * 1000);
      }
    }

    throw lastError;
  }

  private writeLog(source: "manual" | "scheduled" | "system", status: "info" | "success" | "error", message: string): void {
    this.storage.addLog({
      source,
      status,
      message,
      createdAt: new Date().toISOString()
    });
  }

  private async refreshChannelAvatar(channelId: string, avatarUrl: string | null): Promise<boolean> {
    if (!avatarUrl) {
      return false;
    }

    try {
      const response = await fetch(avatarUrl);
      if (!response.ok) {
        return false;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        return false;
      }

      mkdirSync(this.paths.avatarsDir, { recursive: true });
      const extension = resolveAvatarExtension(avatarUrl, response.headers.get("content-type"));
      const fileName = `${channelId}${extension}`;
      const filePath = join(this.paths.avatarsDir, fileName);

      for (const staleExt of [".jpg", ".jpeg", ".png", ".webp"]) {
        const stalePath = join(this.paths.avatarsDir, `${channelId}${staleExt}`);
        if (stalePath !== filePath) {
          rmSync(stalePath, { force: true });
        }
      }

      writeFileSync(filePath, buffer);
      this.storage.updateChannelAvatar(channelId, fileName, new Date().toISOString());
      return true;
    } catch {
      // Avatar caching is best-effort and must never block the main workflow.
      return false;
    }
  }
}

async function diagnose(name: string, url: string): Promise<DiagnosticsResponse["items"][number]> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      name,
      status: response.ok ? "ok" : "error",
      detail: summarizeDiagnosticDetail(url, response.status, text),
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start
    };
  } catch (error) {
    return {
      name,
      status: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
      detail: error instanceof Error ? error.message : "请求失败",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getTaskInfo(rootDir: string): Promise<DiagnosticsResponse["taskInfo"]> {
  try {
    const { stdout } = await execFileAsync("schtasks.exe", ["/query", "/tn", "YouTube Sentinel Worker", "/fo", "list", "/v"], {
      cwd: rootDir,
      windowsHide: true
    });

    const read = (...labels: string[]): string => {
      const line = stdout.split(/\r?\n/).find((item) => labels.some((label) => item.toLowerCase().startsWith(label.toLowerCase())));
      return line?.split(":", 2)[1]?.trim() ?? "--";
    };

    return {
      registered: !stdout.includes("ERROR:"),
      state: read("Status", "状态"),
      lastRunTime: read("Last Run Time", "上次运行时间"),
      lastResult: read("Last Result", "上次结果")
    };
  } catch {
    return {
      registered: false,
      state: "未注册",
      lastRunTime: "--",
      lastResult: "--"
    };
  }
}

function summarizeDiagnosticDetail(url: string, statusCode: number, text: string): string {
  const host = new URL(url).hostname;
  const normalized = text.replace(/\s+/g, " ").trim();
  const ipMatch = normalized.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/i);
  if (ipMatch) {
    return `连接成功，站点 ${host}，检测到出口 IP：${ipMatch[0]}`;
  }

  const titleMatch = normalized.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return `连接成功，站点 ${host}，页面标题：${decodeHtml(titleMatch[1])}`;
  }

  return `连接成功，站点 ${host}，HTTP ${statusCode}`;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatConfidenceLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "中";
  }

  const normalized = value.toLowerCase();
  if (normalized === "high") {
    return "高";
  }
  if (normalized === "low") {
    return "低";
  }
  return "中";
}

function resolveAvatarExtension(url: string, contentType: string | null): ".jpg" | ".jpeg" | ".png" | ".webp" {
  const normalizedContentType = (contentType ?? "").toLowerCase();
  if (normalizedContentType.includes("png")) {
    return ".png";
  }
  if (normalizedContentType.includes("webp")) {
    return ".webp";
  }
  if (normalizedContentType.includes("jpeg") || normalizedContentType.includes("jpg")) {
    return ".jpg";
  }

  const extension = extname(new URL(url).pathname).toLowerCase();
  if (extension === ".png") {
    return ".png";
  }
  if (extension === ".webp") {
    return ".webp";
  }
  if (extension === ".jpeg") {
    return ".jpeg";
  }
  return ".jpg";
}

function getContentTypeByExt(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}
