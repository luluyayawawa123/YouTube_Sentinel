import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimePaths } from "@worker/runtime";
import type { DiagnosticStatus } from "@shared/types";
import { getFirefoxSource } from "@shared/firefox";

const execFileAsync = promisify(execFile);

export interface ResolvedChannel {
  channelId: string;
  channelName: string;
  canonicalUrl: string;
  avatarUrl: string | null;
}

export interface TargetVideoEntry {
  videoId: string;
  title: string;
  publishedAt: string;
  url: string;
}

function getBinaryPath(paths: RuntimePaths): string {
  return join(paths.binDir, "yt-dlp.exe");
}

async function runYtDlp(paths: RuntimePaths, args: string[]): Promise<string> {
  const binaryPath = getBinaryPath(paths);
  if (!existsSync(binaryPath)) {
    throw new Error("缺少 bin/yt-dlp.exe，请补齐软件运行文件。");
  }

  const denoPath = join(paths.binDir, "deno.exe");
  const firefoxSource = getFirefoxSource(paths.configDir);
  const options = ["--encoding", "utf-8"];
  if (existsSync(denoPath)) {
    options.push("--js-runtimes", `deno:${denoPath}`);
  }
  // Re-extract live Firefox cookies each time; no exported file can go stale.
  // An explicit user profile root also works for the SYSTEM scheduled worker.
  if (firefoxSource) {
    options.push("--cookies-from-browser", `firefox:${firefoxSource}`);
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, [...options, ...args], {
      cwd: paths.rootDir,
      windowsHide: true,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 64
    });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string; killed?: boolean; code?: string | number; signal?: string };
    const detail = failure.stderr || failure.message || "未知错误";
    const verificationRequired = /confirm you.{0,12}re not a bot|sign in to confirm/i.test(detail);
    let message: string;
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      message = "视频元数据量超过处理上限，未能完成读取。这不是 Firefox 登录失败。";
    } else if (verificationRequired) {
      message = `YouTube 要求登录验证。${firefoxSource ? "已自动读取 Firefox 当前 Cookies，请确认设置中所选配置与 Firefox 正在使用的一致，再确认 YouTube 登录及网页验证。" : "尚未确定 Firefox 配置，请打开一次软件界面，在设置的诊断区域选择已登录 YouTube 的 Firefox 配置。"}${existsSync(denoPath) ? "" : "同时缺少 bin/deno.exe，请补齐运行时。"}`;
    } else if (/could not find firefox cookies database|failed to load cookies|unable to open database|could not copy.*cookie/i.test(detail)) {
      message = "无法读取 Firefox 登录状态，请确认本机 Firefox 已登录 YouTube；若浏览器正在占用数据，关闭 Firefox 后重试。软件会在下次巡检自动重新读取，无需导出文件。";
    } else if (failure.killed) {
      message = "YouTube 数据获取超时（120 秒），请检查网络后重试。";
    } else if (/No supported JavaScript runtime/i.test(detail) && !existsSync(denoPath)) {
      message = "缺少 JavaScript 运行时，请将 deno.exe 放到软件 bin 目录后重新巡检。";
    } else {
      const clean = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@");
      // Never display a truncated metadata JSON as an error message.
      const stdout = failure.stdout?.trim() ?? "";
      const output = clean(`${failure.stderr ?? ""}\n${/^(?:\{|\[)/.test(stdout) ? "" : stdout}`).trim();
      const errorLines = output.split(/\r?\n/).filter((line) => /^\s*ERROR:/i.test(line)).join("\n");
      const exit = typeof failure.code === "number" ? `${failure.code} / 0x${(failure.code >>> 0).toString(16).toUpperCase()}` : failure.code ?? "未知";
      const reason = errorLines || output || clean(failure.message || "内核没有输出错误说明");
      message = `yt-dlp 执行失败（退出码 ${exit}${failure.signal ? `，信号 ${failure.signal}` : ""}）：${reason.slice(-1800)}`;
    }
    throw new Error(message);
  }
}

export async function diagnoseYtDlp(paths: RuntimePaths, onProgress?: (item: DiagnosticStatus) => void): Promise<DiagnosticStatus[]> {
  return Promise.all([["yt-dlp", "yt-dlp.exe"], ["Deno 运行时", "deno.exe"]].map(async ([name, file]) => {
    const start = Date.now();
    let item: DiagnosticStatus;
    try {
      const { stdout } = await execFileAsync(join(paths.binDir, file), ["--version"], {
        windowsHide: true, encoding: "utf8", timeout: 10_000
      });
      item = { name, status: "ok", detail: stdout.trim(), checkedAt: new Date().toISOString(), durationMs: Date.now() - start };
    } catch (error) {
      const failure = error as Error & { code?: string | number; stderr?: string; stdout?: string };
      const exit = typeof failure.code === "number" ? `0x${(failure.code >>> 0).toString(16).toUpperCase()}` : failure.code ?? "未知";
      item = { name, status: "error", detail: `bin/${file} 无法运行（${exit}）：${(failure.stderr || failure.stdout || failure.message).trim().slice(-1400)}`, checkedAt: new Date().toISOString(), durationMs: Date.now() - start };
    }
    onProgress?.(item);
    return item;
  }));
}

export async function resolveChannelInfo(paths: RuntimePaths, url: string): Promise<ResolvedChannel> {
  const raw = await runYtDlp(paths, ["--flat-playlist", "--playlist-items", "1", "--dump-single-json", url]);
  const parsed = JSON.parse(raw);

  const channelId = parsed.channel_id || parsed.uploader_id || parsed.id;
  const channelName = parsed.channel || parsed.uploader || parsed.title;

  if (!channelId || !channelName) {
    throw new Error("Unable to resolve channel metadata from yt-dlp");
  }

  return {
    channelId,
    channelName,
    canonicalUrl: `https://www.youtube.com/channel/${channelId}`,
    avatarUrl: extractBestAvatarUrl(parsed)
  };
}

export async function fetchLatestTargetEntries(paths: RuntimePaths, url: string, limit = 1): Promise<TargetVideoEntry[]> {
  const raw = await runYtDlp(paths, [
    "--flat-playlist",
    "--playlist-items",
    `1:${Math.max(1, limit)}`,
    "--dump-single-json",
    url
  ]);
  const parsed = JSON.parse(raw) as {
    entries?: Array<Record<string, unknown>>;
  };

  return (parsed.entries ?? [])
    .map((entry) => {
      const videoId = String(entry.id ?? "").trim();
      const webpageUrl = String(entry.url ?? "").trim();

      return {
        videoId,
        title: String(entry.title ?? "Untitled").trim() || "Untitled",
        publishedAt: normalizePublishDate(
          typeof entry.upload_date === "string" ? entry.upload_date : undefined,
          typeof entry.timestamp === "number" ? entry.timestamp : undefined
        ),
        url: webpageUrl.startsWith("http") ? webpageUrl : `https://www.youtube.com/watch?v=${videoId}`
      };
    })
    .filter((entry) => entry.videoId && entry.url);
}

export interface SubtitleCandidate {
  lang: string;
  url: string;
  ext: string;
}

export async function verifyYoutubeLogin(paths: RuntimePaths): Promise<void> {
  // The subscriptions extractor requires account cookies. Fetch zero videos;
  // this only validates access to the authenticated feed.
  const raw = await runYtDlp(paths, [
    "--flat-playlist", "--playlist-items", "0", "--skip-download", "--dump-single-json", ":ytsubs"
  ]);
  const parsed = JSON.parse(raw);
  if (parsed._type !== "playlist" || !/^(?:FE)?subscriptions$/i.test(String(parsed.id ?? ""))) {
    throw new Error("登录检测未获得有效的订阅页响应，暂时无法确认登录状态。");
  }
}

export interface VideoMetadata {
  title: string;
  description: string;
  webpageUrl: string;
  publishedAt: string;
  channelName: string;
  chapters: Array<{ title: string; startTime: number }> | undefined;
  subtitles: SubtitleCandidate[];
}

export async function getVideoMetadata(paths: RuntimePaths, url: string): Promise<VideoMetadata> {
  const raw = await runYtDlp(paths, [
    "--skip-download", "--no-playlist",
    "--extractor-args", "youtube:skip=translated_subs",
    "--print", "%(.{title,description,webpage_url,upload_date,timestamp,channel,uploader,chapters,subtitles,automatic_captions})j",
    url
  ]);
  const parsed = JSON.parse(raw);

  return {
    title: parsed.title ?? "Untitled",
    description: parsed.description ?? "",
    webpageUrl: parsed.webpage_url ?? url,
    publishedAt: normalizePublishDate(parsed.upload_date, parsed.timestamp),
    channelName: parsed.channel ?? parsed.uploader ?? "",
    chapters: parsed.chapters,
    subtitles: extractSubtitleCandidates(parsed)
  };
}

function normalizePublishDate(uploadDate?: string, timestamp?: number): string {
  if (timestamp) {
    return new Date(timestamp * 1000).toISOString();
  }

  if (uploadDate && /^\d{8}$/.test(uploadDate)) {
    const year = uploadDate.slice(0, 4);
    const month = uploadDate.slice(4, 6);
    const day = uploadDate.slice(6, 8);
    return new Date(`${year}-${month}-${day}T00:00:00Z`).toISOString();
  }

  return new Date().toISOString();
}

function extractSubtitleCandidates(parsed: Record<string, unknown>): SubtitleCandidate[] {
  const result: SubtitleCandidate[] = [];
  const buckets = [parsed.subtitles, parsed.automatic_captions] as Array<Record<string, Array<Record<string, string>>> | undefined>;

  for (const bucket of buckets) {
    if (!bucket) {
      continue;
    }

    for (const [lang, items] of Object.entries(bucket)) {
      const hit = items.find((item) => item.ext === "json3" || item.ext === "vtt" || item.ext === "srv3") ?? items[0];
      if (!hit?.url) {
        continue;
      }

      result.push({
        lang,
        url: hit.url,
        ext: hit.ext ?? "unknown"
      });
    }
  }

  return result;
}

function extractBestAvatarUrl(parsed: Record<string, unknown>): string | null {
  const thumbnails = parsed.thumbnails;
  if (Array.isArray(thumbnails)) {
    const candidates = thumbnails
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const thumbnail = item as Record<string, unknown>;
        const id = typeof thumbnail.id === "string" ? thumbnail.id.trim().toLowerCase() : "";
        const url = typeof thumbnail.url === "string" ? thumbnail.url.trim() : "";
        const width = typeof thumbnail.width === "number" ? thumbnail.width : 0;
        const height = typeof thumbnail.height === "number" ? thumbnail.height : 0;
        const preference = typeof thumbnail.preference === "number" ? thumbnail.preference : 0;
        const ratio = width > 0 && height > 0 ? Math.max(width, height) / Math.max(1, Math.min(width, height)) : Number.POSITIVE_INFINITY;
        const isAvatar = id.includes("avatar");
        const isBanner = id.includes("banner") || (width > 0 && height > 0 && width >= height * 2);

        return url
          ? {
              url,
              score: buildAvatarScore({
                width,
                height,
                ratio,
                preference,
                isAvatar,
                isBanner
              })
            }
          : null;
      })
      .filter((item): item is { url: string; score: number } => Boolean(item))
      .sort((a, b) => b.score - a.score);

    if (candidates[0]?.url) {
      return candidates[0].url;
    }
  }

  if (typeof parsed.thumbnail === "string" && parsed.thumbnail.trim()) {
    return parsed.thumbnail.trim();
  }

  return null;
}

function buildAvatarScore(input: {
  width: number;
  height: number;
  ratio: number;
  preference: number;
  isAvatar: boolean;
  isBanner: boolean;
}): number {
  const area = input.width * input.height;
  const squareBonus = Number.isFinite(input.ratio) ? Math.max(0, 3 - input.ratio) * 10_000 : 0;
  const avatarBonus = input.isAvatar ? 1_000_000_000 : 0;
  const bannerPenalty = input.isBanner ? -1_000_000_000 : 0;
  const preferenceBonus = input.preference * 1_000;
  return avatarBonus + bannerPenalty + squareBonus + preferenceBonus + area;
}

export async function fetchSubtitleText(candidate: SubtitleCandidate): Promise<string> {
  const response = await fetch(candidate.url);
  if (!response.ok) {
    throw new Error(`Subtitle request failed with ${response.status}`);
  }

  const text = await response.text();
  if (candidate.ext === "json3" || text.trim().startsWith("{")) {
    const parsed = JSON.parse(text) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    return (parsed.events ?? [])
      .flatMap((event) => event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
