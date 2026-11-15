import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { DiagnosticStatus, YoutubeLoginStatus } from "@shared/types";
import type { RuntimePaths } from "@worker/runtime";
import { getFirefoxSource } from "@shared/firefox";
import { verifyYoutubeLogin } from "@worker/integrations/ytdlp";

const { DatabaseSync } = module.require("node:sqlite") as { DatabaseSync: typeof NodeDatabaseSync };

export const LOGIN_DIAGNOSTIC_NAMES = ["YouTube 登录状态", "Firefox Cookies 读取"];

export function youtubeLoginDiagnostics(result: YoutubeLoginStatus, durationMs = 0): DiagnosticStatus[] {
  if (!result.checkedAt) return [];
  return [
    {
      name: LOGIN_DIAGNOSTIC_NAMES[0], status: result.login === "logged_in" ? "ok" : result.login === "unknown" ? "unknown" : "error",
      detail: result.login === "logged_in" ? "已登录，YouTube 已确认当前登录状态。" : result.detail,
      checkedAt: result.checkedAt, durationMs
    },
    {
      name: LOGIN_DIAGNOSTIC_NAMES[1], status: result.cookies === "normal" ? "ok" : "error",
      detail: result.cookies === "normal" ? "正常，已成功读取 Firefox Cookies。" : result.detail,
      checkedAt: result.checkedAt, durationMs
    }
  ];
}

export function getYoutubeLoginStatus(paths: RuntimePaths): YoutubeLoginStatus {
  try {
    const saved = JSON.parse(readFileSync(join(paths.dataDir, "youtube-login-status.json"), "utf8"));
    if (saved && saved.source === getFirefoxSource(paths.configDir)
      && ["normal", "unavailable", "unknown"].includes(saved.cookies)
      && ["logged_in", "not_logged_in", "verification_required", "unknown"].includes(saved.login)
      && typeof saved.detail === "string" && typeof saved.checkedAt === "string") {
      return { cookies: saved.cookies, login: saved.login, detail: saved.detail, checkedAt: saved.checkedAt };
    }
  } catch { /* No previous check. */ }
  return { cookies: "unknown", login: "unknown", detail: "尚未检测，下次巡检自动检测。", checkedAt: null };
}

function newestCookieDatabase(root: string): string | null {
  const databases: Array<{ path: string; time: number }> = [];
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) scan(join(dir, entry.name));
      if (entry.isFile() && entry.name === "cookies.sqlite") {
        const path = join(dir, entry.name);
        databases.push({ path, time: statSync(path).mtimeMs });
      }
    }
  }
  scan(root);
  return databases.sort((a, b) => b.time - a.time)[0]?.path ?? null;
}

// Cookies stay in memory. Only the three result fields and timestamp are
// persisted, never browser credentials or a cookie export.
export async function checkYoutubeLogin(paths: RuntimePaths, onCookiesReady?: (result: YoutubeLoginStatus) => void): Promise<YoutubeLoginStatus> {
  const source = getFirefoxSource(paths.configDir);
  let cookiesReported = false;
  const result: YoutubeLoginStatus = { cookies: "unavailable", login: "unknown", detail: "尚未确定 Firefox 配置。请在本机打开一次软件界面，并在设置的诊断区域选择正在登录 YouTube 的 Firefox 配置。", checkedAt: new Date().toISOString() };
  try {
    if (!source) return result;
    const databasePath = newestCookieDatabase(source);
    if (!databasePath) { result.detail = "尚未找到 Firefox Cookies，请在 Firefox 打开并登录 YouTube。"; return result; }
    let database: NodeDatabaseSync | undefined;
    let rows: Array<{ expiry: number }>;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 3000");
      rows = database.prepare("SELECT expiry FROM moz_cookies WHERE host IN ('.youtube.com', 'youtube.com', 'www.youtube.com') AND path = '/'").all() as typeof rows;
    } finally { database?.close(); }
    result.cookies = "normal";
    onCookiesReady?.({ ...result });
    cookiesReported = true;
    const hasCookies = rows.some((row) => {
      const expiry = row.expiry > 1e12 ? row.expiry / 1000 : row.expiry;
      return expiry === 0 || expiry * 1000 > Date.now();
    });
    if (!hasCookies) {
      result.login = "not_logged_in";
      result.detail = "Cookies 读取正常，但没有可用的 YouTube 登录信息，请在 Firefox 登录 YouTube。";
      return result;
    }
    // Use the same executable, profile and networking as actual monitoring.
    await verifyYoutubeLogin(paths);
    result.login = "logged_in";
    result.detail = "Firefox Cookies 读取正常，yt-dlp 已通过需要登录的 YouTube 订阅页验证。";
  } catch (error) {
    const failure = error as Error & { cause?: { message?: string; code?: string } };
    const reason = [failure.message, failure.cause?.code, failure.cause?.message].filter(Boolean).join("；").slice(0, 400);
    if (/Login details are needed|requires? (?:you to )?(?:be )?log(?:ged)?[ -]?in|cookies.*no longer valid/i.test(reason)) result.login = "not_logged_in";
    if (/YouTube 要求登录验证|confirm you.{0,12}re not a bot|recaptcha/i.test(reason)) result.login = "verification_required";
    result.detail = result.cookies === "normal"
      ? `Cookies 读取正常，但暂时无法确认 YouTube 登录状态：${reason}`
      : `无法读取 Firefox Cookies：${reason}`;
  } finally {
    if (!cookiesReported) onCookiesReady?.({ ...result });
    try { writeFileSync(join(paths.dataDir, "youtube-login-status.json"), JSON.stringify({ ...result, source }, null, 2), "utf8"); } catch { /* Do not interrupt monitoring. */ }
  }
  return result;
}
