import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AppSettings } from "@shared/types";
import { channelPayloadSchema, settingsSchema } from "@shared/validation";
import { workWindowLabel } from "@shared/utils";
import { resolvePort, resolveRuntimePaths, loadSettings, saveSettings } from "@worker/runtime";
import { PollScheduler } from "@worker/scheduler";
import { WorkerService } from "@worker/service";
import { Storage } from "@worker/storage";

export interface WorkerController {
  close: () => void;
}

export async function startWorkerServer(): Promise<WorkerController> {
  const paths = resolveRuntimePaths();
  let settings = loadSettings(paths);
  const storage = new Storage(paths.dbPath);
  const scheduler = new PollScheduler();
  const service = new WorkerService(storage, paths, settings);
  const port = resolvePort();

  scheduler.configure(settings.monitor, async () => {
    await service.syncAllChannels("scheduled");
  });

  const server = createServer(async (request, response) => {
    setHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { ok: true, data: { status: "ok" } });
        return;
      }

      if (request.method === "GET" && pathname === "/dashboard") {
        const taskInfo = await service.getTaskInfo();
        sendJson(response, 200, {
          ok: true,
          data: storage.buildDashboard(
            "running",
            taskInfo.registered,
            settings.monitor.intervalMinutes,
            scheduler.getNextRunAt(),
            workWindowLabel(
              settings.monitor.workWindow.enabled,
              settings.monitor.workWindow.start,
              settings.monitor.workWindow.end
            )
          )
        });
        return;
      }

      if (request.method === "GET" && pathname === "/channels") {
        sendJson(response, 200, { ok: true, data: storage.listChannels() });
        return;
      }

      if (request.method === "POST" && pathname === "/channels") {
        const body = channelPayloadSchema.parse(await readJson(request));
        const channel = await service.addOrUpdateChannel(body);
        sendJson(response, 200, { ok: true, data: channel });
        return;
      }

      const channelMatch = pathname.match(/^\/channels\/([^/]+)$/);
      if (request.method === "PUT" && channelMatch) {
        const body = channelPayloadSchema.parse(await readJson(request));
        const channel = await service.addOrUpdateChannel({
          id: channelMatch[1],
          ...body
        });
        sendJson(response, 200, { ok: true, data: channel });
        return;
      }

      if (request.method === "DELETE" && channelMatch) {
        storage.deleteChannel(channelMatch[1]);
        sendJson(response, 200, { ok: true, data: true });
        return;
      }

      const channelSyncMatch = pathname.match(/^\/channels\/([^/]+)\/check$/);
      if (request.method === "POST" && channelSyncMatch) {
        const count = await service.syncSingleChannel(channelSyncMatch[1], "manual");
        sendJson(response, 200, { ok: true, data: { processed: count } });
        return;
      }

      const channelAvatarMatch = pathname.match(/^\/channels\/([^/]+)\/avatar$/);
      if (request.method === "GET" && channelAvatarMatch) {
        const avatar = service.getAvatarFile(channelAvatarMatch[1]);
        if (!avatar) {
          sendJson(response, 404, { ok: false, error: "Avatar not found" });
          return;
        }

        sendBinary(response, 200, avatar.contentType, avatar.buffer);
        return;
      }

      if (request.method === "GET" && pathname === "/settings") {
        sendJson(response, 200, { ok: true, data: settings });
        return;
      }

      if (request.method === "PUT" && pathname === "/settings") {
        const nextSettings = settingsSchema.parse(await readJson(request)) as AppSettings;
        settings = nextSettings;
        service.updateSettings(nextSettings);
        saveSettings(paths, nextSettings);
        scheduler.configure(nextSettings.monitor, async () => {
          await service.syncAllChannels("scheduled");
        });
        sendJson(response, 200, {
          ok: true,
          data: {
            settings: nextSettings,
            applyScope: {
              monitor: "next_poll",
              ai: "immediate",
              telegram: "immediate",
              history: "immediate",
              ui: "immediate"
            }
          }
        });
        return;
      }

      if (request.method === "GET" && pathname === "/history") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        sendJson(response, 200, {
          ok: true,
          data: {
            items: storage.listRecentHistory(limit, offset),
            total: storage.countHistory()
          }
        });
        return;
      }

      if (request.method === "GET" && pathname === "/logs") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        sendJson(response, 200, {
          ok: true,
          data: {
            items: storage.listLogs(limit, offset),
            total: storage.countLogs()
          }
        });
        return;
      }

      if (request.method === "POST" && pathname === "/history/cleanup") {
        const body = await readJson(request) as { days?: number };
        service.cleanupHistoryByDays(Number(body.days));
        sendJson(response, 200, { ok: true, data: true });
        return;
      }

      if (request.method === "GET" && pathname === "/diagnostics") {
        const diagnostics = await service.getDiagnostics();
        sendJson(response, 200, { ok: true, data: diagnostics });
        return;
      }

      if (request.method === "POST" && pathname === "/diagnostics/run") {
        const diagnostics = await service.runDiagnostics();
        sendJson(response, 200, { ok: true, data: diagnostics });
        return;
      }

      if (request.method === "POST" && pathname === "/actions/test-ai") {
        const message = await service.testAi();
        sendJson(response, 200, { ok: true, data: { message } });
        return;
      }
      if (request.method === "POST" && pathname === "/actions/test-telegram") {
        await service.testTelegram();
        sendJson(response, 200, { ok: true, data: true });
        return;
      }

      if (request.method === "POST" && pathname === "/actions/sync-now") {
        await service.syncAllChannels("manual");
        sendJson(response, 200, { ok: true, data: true });
        return;
      }

      if (request.method === "POST" && pathname === "/actions/clear-avatar-cache") {
        const cleared = await service.clearAvatarCache();
        sendJson(response, 200, { ok: true, data: { cleared } });
        return;
      }

      if (request.method === "POST" && pathname === "/actions/refresh-avatars") {
        const result = await service.refreshAllChannelAvatars();
        sendJson(response, 200, { ok: true, data: result });
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    close: () => {
      scheduler.stop();
      storage.close();
      server.close();
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Uint8Array);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendBinary(response: ServerResponse, statusCode: number, contentType: string, payload: Buffer): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
}

