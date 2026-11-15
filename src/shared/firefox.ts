import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FirefoxProfiles } from "@shared/types";

const SOURCE_FILE = "firefox-source.json";

// Firefox's registered default is stable. A recently flushed, unused profile
// must not replace the one the user actually logs into.
function profileSections(root: string): Array<Record<string, string>> {
  try {
    const ini = readFileSync(join(dirname(root), "profiles.ini"), "utf8").replace(/^\uFEFF/, "");
    const sections: Array<Record<string, string>> = [];
    let section: Record<string, string> = {};
    for (const raw of ini.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) { section = { section: line }; sections.push(section); }
      else if (line.includes("=") && !line.startsWith(";")) {
        const index = line.indexOf("="); section[line.slice(0, index)] = line.slice(index + 1);
      }
    }
    return sections;
  } catch { return []; }
}

function defaultProfile(root: string): string | null {
    const sections = profileSections(root);
    const candidates = [
      ...sections.filter((item) => item.section?.startsWith("[Install") && item.Default).map((item) => resolve(dirname(root), item.Default)),
      ...sections.filter((item) => item.section?.startsWith("[Profile") && item.Default === "1" && item.Path)
        .map((item) => item.IsRelative === "0" ? item.Path : resolve(dirname(root), item.Path))
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
}

// Only store the location, never a snapshot of login credentials. The UI runs
// as the user; the SYSTEM worker reads this location afresh on every request.
export function rememberFirefoxSource(configDir: string, appData: string): void {
  if (!appData || /[\\/]systemprofile[\\/]/i.test(`${appData}/`)) return;
  mkdirSync(configDir, { recursive: true });
  const root = join(appData, "Mozilla", "Firefox", "Profiles");
  let profilePath: string | undefined;
  try {
    const saved = JSON.parse(readFileSync(join(configDir, SOURCE_FILE), "utf8").replace(/^\uFEFF/, ""));
    if (saved.profilesRoot === root && typeof saved.profilePath === "string") profilePath = saved.profilePath;
  } catch { /* New machine/user starts without a pinned profile. */ }
  writeFileSync(join(configDir, SOURCE_FILE), JSON.stringify({
    profilesRoot: root, ...(profilePath ? { profilePath } : {})
  }, null, 2), "utf8");
}

function getFirefoxRoot(configDir: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(configDir, SOURCE_FILE), "utf8").replace(/^\uFEFF/, ""));
    if (typeof saved.profilesRoot === "string" && isAbsolute(saved.profilesRoot) && existsSync(saved.profilesRoot)) {
      return saved.profilesRoot;
    }
  } catch {
    // Before the UI has opened, a directly started user worker can still use
    // its own Firefox. Do not scan unrelated Windows accounts.
  }
  const appData = process.env.APPDATA;
  if (!appData || /[\\/]systemprofile[\\/]/i.test(`${appData}/`)) return null;
  const root = join(appData, "Mozilla", "Firefox", "Profiles");
  return existsSync(root) ? root : null;
}

export function getFirefoxProfiles(configDir: string): FirefoxProfiles {
  const root = getFirefoxRoot(configDir);
  const profiles: FirefoxProfiles["profiles"] = [];
  let automaticPath = root ? defaultProfile(root) : null;
  if (root) {
    for (const item of profileSections(root).filter((entry) => entry.section?.startsWith("[Profile") && entry.Path)) {
      const path = item.IsRelative === "0" ? item.Path : resolve(dirname(root), item.Path);
      if (existsSync(path)) profiles.push({ name: item.Name || basename(path), path, isDefault: path === automaticPath });
    }
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && existsSync(join(path, "cookies.sqlite")) && !profiles.some((item) => item.path === path)) {
          profiles.push({ name: entry.name, path, isDefault: path === automaticPath });
        }
      }
    } catch { /* Inaccessible/empty root is handled by diagnostics. */ }
    if (!automaticPath && profiles.length === 1) automaticPath = profiles[0].path;
  }
  let selectedPath: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(join(configDir, SOURCE_FILE), "utf8").replace(/^\uFEFF/, ""));
    if (typeof saved.profilePath === "string") selectedPath = saved.profilePath;
  } catch { /* Automatic mode. */ }
  return { profiles, selectedPath, automaticPath };
}

export function setFirefoxProfile(configDir: string, profilePath: string | null): FirefoxProfiles {
  const root = getFirefoxRoot(configDir);
  if (!root) throw new Error("未找到本机 Firefox 目录，请先打开一次软件界面。");
  if (profilePath !== null && !getFirefoxProfiles(configDir).profiles.some((item) => item.path === profilePath)) throw new Error("所选 Firefox 配置已不存在，请重新选择。");
  writeFileSync(join(configDir, SOURCE_FILE), JSON.stringify({ profilesRoot: root, ...(profilePath ? { profilePath } : {}) }, null, 2), "utf8");
  return getFirefoxProfiles(configDir);
}

export function getFirefoxSource(configDir: string): string | null {
  const root = getFirefoxRoot(configDir);
  if (!root) return null;
  const { selectedPath, automaticPath, profiles } = getFirefoxProfiles(configDir);
  if (selectedPath) return existsSync(selectedPath) ? selectedPath : null;
  if (automaticPath) return automaticPath;
  return profiles.length > 1 ? null : root;
}
