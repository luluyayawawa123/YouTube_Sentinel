import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { Channel, DashboardResponse, DeliveryRecord, DiagnosticsResponse, HistoryRecord, LogRecord, VideoRecord } from "@shared/types";
import { makeId } from "@shared/utils";

const { DatabaseSync } = module.require("node:sqlite") as {
  DatabaseSync: typeof NodeDatabaseSync;
};

export class Storage {
  private readonly db: NodeDatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        channel_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_checked_at TEXT,
        last_video_at TEXT,
        last_error TEXT,
        avatar_path TEXT,
        avatar_updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        source_level TEXT NOT NULL,
        process_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        tg_status TEXT NOT NULL,
        sent_at TEXT,
        retry_count INTEGER NOT NULL,
        error_message TEXT,
        message_preview TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        ref_id TEXT,
        channel_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expire_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostics (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_logs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.ensureColumn("channels", "avatar_path", "TEXT");
    this.ensureColumn("channels", "avatar_updated_at", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  listChannels(): Channel[] {
    return this.db
      .prepare(`
        SELECT
          id,
          original_url AS originalUrl,
          canonical_url AS canonicalUrl,
          channel_id AS channelId,
          name,
          enabled,
          last_checked_at AS lastCheckedAt,
          last_video_at AS lastVideoAt,
          last_error AS lastError,
          avatar_path AS avatarPath,
          avatar_updated_at AS avatarUpdatedAt
        FROM channels
        ORDER BY name COLLATE NOCASE ASC
      `)
      .all() as unknown as Channel[];
  }

  upsertChannel(channel: Channel): void {
    this.db
      .prepare(`
        INSERT INTO channels (
          id, original_url, canonical_url, channel_id, name, enabled, last_checked_at, last_video_at, last_error, avatar_path, avatar_updated_at
        ) VALUES (
          @id, @originalUrl, @canonicalUrl, @channelId, @name, @enabled, @lastCheckedAt, @lastVideoAt, @lastError, @avatarPath, @avatarUpdatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          original_url = excluded.original_url,
          canonical_url = excluded.canonical_url,
          channel_id = excluded.channel_id,
          name = excluded.name,
          enabled = excluded.enabled,
          last_checked_at = excluded.last_checked_at,
          last_video_at = excluded.last_video_at,
          last_error = excluded.last_error,
          avatar_path = excluded.avatar_path,
          avatar_updated_at = excluded.avatar_updated_at
      `)
      .run({
        ...channel,
        enabled: channel.enabled ? 1 : 0
      });
  }

  deleteChannel(id: string): void {
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  getChannel(id: string): Channel | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          original_url AS originalUrl,
          canonical_url AS canonicalUrl,
          channel_id AS channelId,
          name,
          enabled,
          last_checked_at AS lastCheckedAt,
          last_video_at AS lastVideoAt,
          last_error AS lastError,
          avatar_path AS avatarPath,
          avatar_updated_at AS avatarUpdatedAt
        FROM channels
        WHERE id = ?
      `)
      .get(id) as Channel | undefined;
  }

  getChannelByCanonical(channelId: string): Channel | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          original_url AS originalUrl,
          canonical_url AS canonicalUrl,
          channel_id AS channelId,
          name,
          enabled,
          last_checked_at AS lastCheckedAt,
          last_video_at AS lastVideoAt,
          last_error AS lastError,
          avatar_path AS avatarPath,
          avatar_updated_at AS avatarUpdatedAt
        FROM channels
        WHERE channel_id = ?
      `)
      .get(channelId) as Channel | undefined;
  }

  updateChannelRuntime(id: string, fields: Pick<Channel, "lastCheckedAt" | "lastVideoAt" | "lastError">): void {
    this.db
      .prepare(`
        UPDATE channels
        SET last_checked_at = @lastCheckedAt,
            last_video_at = @lastVideoAt,
            last_error = @lastError
        WHERE id = @id
      `)
      .run({ id, ...fields });
  }

  updateChannelAvatar(id: string, avatarPath: string | null, avatarUpdatedAt: string | null): void {
    this.db
      .prepare(`
        UPDATE channels
        SET avatar_path = ?,
            avatar_updated_at = ?
        WHERE id = ?
      `)
      .run(avatarPath, avatarUpdatedAt, id);
  }

  clearChannelAvatars(): void {
    this.db.prepare("UPDATE channels SET avatar_path = NULL, avatar_updated_at = NULL").run();
  }

  hasVideo(videoId: string): boolean {
    const row = this.db.prepare("SELECT video_id FROM videos WHERE video_id = ?").get(videoId) as { video_id?: string } | undefined;
    return Boolean(row?.video_id);
  }

  addVideo(video: {
    videoId: string;
    channelId: string;
    title: string;
    publishedAt: string;
    rawPayload: string;
    sourceLevel: string;
    processState: string;
  }): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO videos (
          video_id, channel_id, title, published_at, raw_payload, source_level, process_state, created_at
        ) VALUES (
          @videoId, @channelId, @title, @publishedAt, @rawPayload, @sourceLevel, @processState, @createdAt
        )
      `)
      .run({
        ...video,
        createdAt: new Date().toISOString()
      });
  }

  updateVideoState(videoId: string, processState: string, sourceLevel: string): void {
    this.db.prepare("UPDATE videos SET process_state = ?, source_level = ? WHERE video_id = ?").run(processState, sourceLevel, videoId);
  }

  listRecentHistory(limit = 20, offset = 0): HistoryRecord[] {
    return this.db
      .prepare(`
        SELECT
          id,
          type,
          ref_id AS refId,
          channel_id AS channelId,
          title,
          status,
          summary,
          created_at AS createdAt,
          expire_at AS expireAt
        FROM history
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as unknown as HistoryRecord[];
  }

  countHistory(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM history").get() as { total: number };
    return row.total;
  }

  addHistory(entry: Omit<HistoryRecord, "id">): void {
    this.db
      .prepare(`
        INSERT INTO history (
          id, type, ref_id, channel_id, title, status, summary, created_at, expire_at
        ) VALUES (
          @id, @type, @refId, @channelId, @title, @status, @summary, @createdAt, @expireAt
        )
      `)
      .run({
        id: makeId("hist"),
        ...entry
      });
  }

  addDelivery(delivery: Omit<DeliveryRecord, "id">): void {
    this.db
      .prepare(`
        INSERT INTO deliveries (
          id, video_id, tg_status, sent_at, retry_count, error_message, message_preview
        ) VALUES (
          @id, @videoId, @tgStatus, @sentAt, @retryCount, @errorMessage, @messagePreview
        )
      `)
      .run({
        id: makeId("del"),
        ...delivery
      });
  }

  cleanupHistoryBefore(cutoffIso: string): void {
    this.db.prepare("DELETE FROM history WHERE datetime(created_at) < datetime(?)").run(cutoffIso);
    this.db.prepare("DELETE FROM deliveries WHERE sent_at IS NOT NULL AND datetime(sent_at) < datetime(?)").run(cutoffIso);
  }

  cleanupExpiredHistory(): void {
    this.db.prepare("DELETE FROM history WHERE datetime(expire_at) < datetime('now')").run();
  }

  saveDiagnostics(response: DiagnosticsResponse): void {
    this.db.prepare("DELETE FROM diagnostics").run();

    const stmt = this.db.prepare(`
      INSERT INTO diagnostics (name, status, detail, checked_at, duration_ms)
      VALUES (@name, @status, @detail, @checkedAt, @durationMs)
      ON CONFLICT(name) DO UPDATE SET
        status = excluded.status,
        detail = excluded.detail,
        checked_at = excluded.checked_at,
        duration_ms = excluded.duration_ms
    `);

    for (const item of response.items) {
      stmt.run({
        name: item.name,
        status: item.status,
        detail: item.detail,
        checkedAt: item.checkedAt,
        durationMs: item.durationMs
      });
    }
  }

  getDiagnostics(): DiagnosticsResponse["items"] {
    return this.db
      .prepare(`
        SELECT
          name,
          status,
          detail,
          checked_at AS checkedAt,
          duration_ms AS durationMs
        FROM diagnostics
        ORDER BY name ASC
      `)
      .all() as unknown as DiagnosticsResponse["items"];
  }

  addLog(entry: Omit<LogRecord, "id">): void {
    this.db
      .prepare(`
        INSERT INTO execution_logs (
          id, source, status, message, created_at
        ) VALUES (
          @id, @source, @status, @message, @createdAt
        )
      `)
      .run({
        id: makeId("log"),
        ...entry
      });
  }

  listLogs(limit = 20, offset = 0): LogRecord[] {
    return this.db
      .prepare(`
        SELECT
          id,
          source,
          status,
          message,
          created_at AS createdAt
        FROM execution_logs
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as unknown as LogRecord[];
  }

  countLogs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM execution_logs").get() as { total: number };
    return row.total;
  }

  setRuntimeValue(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO runtime_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  getRuntimeValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  buildDashboard(
    workerStatus: DashboardResponse["workerStatus"],
    taskRegistered: boolean,
    intervalMinutes: number,
    nextRunAt: string | null,
    windowLabel: string
  ): DashboardResponse {
    return {
      workerStatus,
      taskRegistered,
      intervalMinutes,
      nextRunAt,
      workWindowLabel: windowLabel,
      lastRunAt: this.getRuntimeValue("lastRunAt"),
      lastRunOutcome: this.getRuntimeValue("lastRunOutcome") ?? "等待首次巡检",
      channelCount: this.listChannels().length,
      historyCount: this.countHistory()
    };
  }

  listVideos(): VideoRecord[] {
    return this.db
      .prepare(`
        SELECT
          video_id AS videoId,
          channel_id AS channelId,
          title,
          published_at AS publishedAt,
          source_level AS sourceLevel,
          process_state AS processState
        FROM videos
        ORDER BY datetime(published_at) DESC
      `)
      .all() as unknown as VideoRecord[];
  }

  close(): void {
    this.db.close();
  }
}

