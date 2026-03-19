import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { DEFAULT_PORT, DEFAULT_SETTINGS } from "@shared/constants";
import type { AppSettings } from "@shared/types";
import { settingsSchema } from "@shared/validation";

export interface RuntimePaths {
  rootDir: string;
  configDir: string;
  dataDir: string;
  logsDir: string;
  avatarsDir: string;
  binDir: string;
  dbPath: string;
  settingsPath: string;
}

export function resolveRootDir(): string {
  if (app.isPackaged) {
    return dirname(process.execPath);
  }

  return process.cwd();
}

export function resolveRuntimePaths(): RuntimePaths {
  const rootDir = resolveRootDir();

  const paths = {
    rootDir,
    configDir: join(rootDir, "config"),
    dataDir: join(rootDir, "data"),
    logsDir: join(rootDir, "logs"),
    avatarsDir: join(rootDir, "data", "avatars"),
    binDir: join(rootDir, "bin"),
    dbPath: join(rootDir, "data", "sentinel.db"),
    settingsPath: join(rootDir, "config", "settings.json")
  };

  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.avatarsDir, { recursive: true });
  mkdirSync(paths.binDir, { recursive: true });

  return paths;
}

export function loadSettings(paths: RuntimePaths): AppSettings {
  if (!existsSync(paths.settingsPath)) {
    writeFileSync(paths.settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
    return structuredClone(DEFAULT_SETTINGS);
  }

  const raw = readFileSync(paths.settingsPath, "utf8");
  const parsed = JSON.parse(raw);
  return settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...parsed,
    monitor: {
      ...DEFAULT_SETTINGS.monitor,
      ...parsed.monitor,
      workWindow: {
        ...DEFAULT_SETTINGS.monitor.workWindow,
        ...parsed.monitor?.workWindow
      }
    },
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...parsed.ai
    },
    telegram: {
      ...DEFAULT_SETTINGS.telegram,
      ...parsed.telegram
    },
    history: {
      ...DEFAULT_SETTINGS.history,
      ...parsed.history
    },
    ui: {
      ...DEFAULT_SETTINGS.ui,
      ...parsed.ui
    }
  });
}

export function saveSettings(paths: RuntimePaths, settings: AppSettings): void {
  writeFileSync(paths.settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

export function resolvePort(): number {
  return DEFAULT_PORT;
}
