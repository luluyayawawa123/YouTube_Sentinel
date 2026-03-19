import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimePaths } from "@worker/runtime";

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
    throw new Error("Missing bin/yt-dlp.exe");
  }

  const { stdout } = await execFileAsync(binaryPath, args, {
    cwd: paths.rootDir,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10
  });

  return stdout;
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
  const raw = await runYtDlp(paths, ["--dump-single-json", "--skip-download", url]);
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
