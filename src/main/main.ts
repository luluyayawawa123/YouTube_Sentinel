import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { app, BrowserWindow, shell } from "electron";
import { startWorkerServer } from "@worker/index";

const isWorkerMode = process.argv.includes("--worker");
const isDevSourceMode = process.env.YTS_DEV_SOURCE === "1";

if (isWorkerMode) {
  app.whenReady()
    .then(async () => {
      writeWorkerStartupLog("worker mode ready");
      await startWorkerServer();
      writeWorkerStartupLog("worker server started");
    })
    .catch((error) => {
      writeWorkerStartupLog(`worker startup failed: ${formatError(error)}`);
      if (isAddressInUseError(error)) {
        app.exit(0);
        return;
      }

      console.error(error);
      app.exit(1);
    });
} else {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
  }

  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      title: "油管哨兵",
      width: 1180,
      height: 820,
      minWidth: 980,
      minHeight: 720,
      backgroundColor: "#f9f9f9",
      autoHideMenuBar: true,
      webPreferences: {
        preload: isDevSourceMode ? join(process.cwd(), "dev-preload.cjs") : join(__dirname, "preload.js"),
        contextIsolation: true
      }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      await window.loadURL(devUrl);
    } else {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }

    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

function isAddressInUseError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (typeof error === "object" && "code" in error && (error as { code?: string }).code === "EADDRINUSE") {
    return true;
  }

  const message = formatError(error);
  return message.includes("EADDRINUSE") || message.includes("address already in use");
}

function writeWorkerStartupLog(message: string): void {
  try {
    const rootDir = app.isPackaged ? process.execPath.replace(/\\[^\\]+$/, "") : process.cwd();
    const logsDir = join(rootDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "worker-startup.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Ignore logging failures. They must never block worker startup.
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
