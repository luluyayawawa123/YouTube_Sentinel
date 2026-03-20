import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_PORT, HISTORY_CLEANUP_OPTIONS, INTERVAL_PRESETS } from "@shared/constants";
import type { AppSettings, Channel, DashboardResponse, DiagnosticStatus, DiagnosticsResponse, HistoryRecord, LogRecord } from "@shared/types";
import { formatLocal, maskSecret } from "@shared/utils";
import packageInfo from "../../package.json";

const API_BASE = `http://127.0.0.1:${DEFAULT_PORT}`;
const CHANNEL_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 10;
const LOG_PAGE_SIZE = 20;

type PageKey = "overview" | "channels" | "history" | "logs" | "settings";
type FeedbackTone = "neutral" | "pending" | "success" | "error";
type ChannelSortKey = "latest" | "oldest" | "name_asc" | "checked_desc";
type ChannelAddDetail = {
  added: string[];
  duplicates: string[];
};

type ChannelFormState = {
  id: string;
  originalUrl: string;
  name: string;
  batchInput: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  monitor: {
    intervalMinutes: 15,
    workWindow: {
      enabled: false,
      start: "08:00",
      end: "23:00"
    }
  },
  ai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini"
  },
  telegram: {
    botToken: "",
    chatId: ""
  },
  history: {
    retentionDays: 365 * 3
  },
  ui: {
    showChannelAvatars: false
  }
};

const EMPTY_CHANNEL_FORM: ChannelFormState = {
  id: "",
  originalUrl: "",
  name: "",
  batchInput: ""
};

const PAGE_META: Record<PageKey, { label: string; title: string; desc: string }> = {
  overview: { label: "概览", title: "总览面板", desc: "集中查看运行状态、推送结果和最近活动。" },
  channels: { label: "监控目标", title: "监控目标管理", desc: "批量维护频道链接，快速编辑并单独巡检目标。" },
  history: { label: "推送历史", title: "推送历史", desc: "保持列表视图，专注标题、摘要、状态与时间。" },
  logs: { label: "执行日志", title: "执行日志", desc: "按时间顺序查看手动和计划执行的详细记录。" },
  settings: { label: "设置与诊断", title: "设置与诊断", desc: "按分区整理设置、测试入口和诊断信息。" }
};

export function App() {
  const [page, setPage] = useState<PageKey>("overview");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [recentHistory, setRecentHistory] = useState<HistoryRecord[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [logTotal, setLogTotal] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [channelPage, setChannelPage] = useState(1);
  const [channelSort, setChannelSort] = useState<ChannelSortKey>("latest");
  const [channelAddDetail, setChannelAddDetail] = useState<ChannelAddDetail | null>(null);
  const [channelAddDetailOpen, setChannelAddDetailOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: FeedbackTone; message: string }>({
    tone: "neutral",
    message: "界面已就绪，等待操作。"
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingChannel, setSavingChannel] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [clearingAvatarCache, setClearingAvatarCache] = useState(false);
  const [refreshingAvatars, setRefreshingAvatars] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [cleaningHistory, setCleaningHistory] = useState(false);
  const [rowAction, setRowAction] = useState<{ type: "sync" | "delete"; id: string } | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelFormState>(EMPTY_CHANNEL_FORM);
  const [secretVisibility, setSecretVisibility] = useState({
    aiApiKey: false,
    telegramBotToken: false,
    telegramChatId: false
  });

  const isEditingChannel = Boolean(channelForm.id);
  const pageMeta = PAGE_META[page];

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshAll();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [historyPage, logPage]);

  useEffect(() => {
    if (page === "overview") {
      void refreshOverviewData();
      return;
    }

    if (page === "channels") {
      void refreshChannels();
      return;
    }

    if (page === "history") {
      void refreshHistory(historyPage);
      return;
    }

    if (page === "logs") {
      void refreshLogs(logPage);
      return;
    }

    if (page === "settings") {
      void Promise.allSettled([refreshSettings(), refreshDiagnostics()]);
    }
  }, [page, historyPage, logPage]);

  async function refreshAll(): Promise<void> {
    await Promise.allSettled([
      refreshDashboard(),
      refreshChannels(),
      refreshRecentHistory(),
      refreshHistory(historyPage),
      refreshLogs(logPage),
      refreshDiagnostics()
    ]);
  }

  async function refreshOverviewData(): Promise<void> {
    await Promise.allSettled([refreshDashboard(), refreshRecentHistory()]);
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      ...init
    });
    const payload = (await response.json()) as { ok: boolean; data?: T; error?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `请求失败：${response.status}`);
    }
    return payload.data as T;
  }

  async function refreshDashboard(): Promise<void> {
    try {
      setDashboard(await api<DashboardResponse>("/dashboard"));
    } catch (error) {
      setDashboard(null);
      setFeedbackState(getErrorMessage(error, "无法获取后台状态"), "error");
    }
  }

  async function refreshChannels(): Promise<void> {
    try {
      setChannels(await api<Channel[]>("/channels"));
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "无法加载监控目标"), "error");
    }
  }

  async function refreshHistory(pageNumber = historyPage): Promise<void> {
    try {
      const offset = (pageNumber - 1) * HISTORY_PAGE_SIZE;
      const data = await api<{ items: HistoryRecord[]; total: number }>(`/history?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`);
      setHistory(data.items);
      setHistoryTotal(data.total);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "无法加载推送历史"), "error");
    }
  }

  async function refreshRecentHistory(): Promise<void> {
    try {
      const data = await api<{ items: HistoryRecord[]; total: number }>("/history?limit=5&offset=0");
      setRecentHistory(data.items);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "最近推送刷新失败"), "error");
    }
  }

  async function refreshSettings(): Promise<void> {
    try {
      setSettings(await api<AppSettings>("/settings"));
      setSettingsDirty(false);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "无法加载设置"), "error");
    }
  }

  function updateSettingsDraft(next: AppSettings | ((previous: AppSettings) => AppSettings)): void {
    setSettings((previous) => {
      if (typeof next === "function") {
        return (next as (previous: AppSettings) => AppSettings)(previous);
      }

      return next;
    });
    setSettingsDirty(true);
  }

  async function refreshDiagnostics(): Promise<void> {
    try {
      setDiagnostics(await api<DiagnosticsResponse>("/diagnostics"));
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "无法读取诊断结果"), "error");
    }
  }

  async function refreshLogs(pageNumber = logPage): Promise<void> {
    try {
      const offset = (pageNumber - 1) * LOG_PAGE_SIZE;
      const data = await api<{ items: LogRecord[]; total: number }>(`/logs?limit=${LOG_PAGE_SIZE}&offset=${offset}`);
      setLogs(data.items);
      setLogTotal(data.total);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "无法加载执行日志"), "error");
    }
  }

  async function saveChannel(): Promise<void> {
    setSavingChannel(true);
    setFeedbackState(isEditingChannel ? "正在保存监控目标..." : "正在添加监控目标...", "pending");

    try {
      if (isEditingChannel) {
        setChannelAddDetail(null);
        setChannelAddDetailOpen(false);
        await api(`/channels/${channelForm.id}`, {
          method: "PUT",
          body: JSON.stringify({
            originalUrl: channelForm.originalUrl.trim(),
            name: channelForm.name.trim()
          })
        });
        setFeedbackState("监控目标已更新。", "success");
      } else {
        const entries = parseBatchEntries(channelForm.batchInput, channelForm.name);
        if (entries.length === 0) {
          throw new Error("请至少输入一个目标链接");
        }

        let addedCount = 0;
        const addedEntries: string[] = [];
        const skippedEntries: string[] = [];

        for (const entry of entries) {
          try {
            await api("/channels", {
              method: "POST",
              body: JSON.stringify(entry)
            });
            addedCount += 1;
            addedEntries.push(entry.name || entry.originalUrl);
          } catch (error) {
            if (error instanceof Error && error.message.includes("已存在")) {
              skippedEntries.push(entry.name || entry.originalUrl);
              continue;
            }
            throw error;
          }
        }

        if (addedEntries.length > 0 || skippedEntries.length > 0) {
          setChannelAddDetail({
            added: addedEntries,
            duplicates: skippedEntries
          });
          setChannelAddDetailOpen(false);
        } else {
          setChannelAddDetail(null);
          setChannelAddDetailOpen(false);
        }

        if (addedCount === 0 && skippedEntries.length > 0) {
          setFeedbackState(`没有新增目标，跳过 ${skippedEntries.length} 个重复项。`, "success");
        } else if (skippedEntries.length > 0) {
          setFeedbackState(`已新增 ${addedCount} 个目标，跳过 ${skippedEntries.length} 个重复项。`, "success");
        } else {
          setFeedbackState(addedCount === 1 ? "监控目标已添加。" : `已批量添加 ${addedCount} 个监控目标。`, "success");
        }
      }

      setChannelForm(EMPTY_CHANNEL_FORM);
      await refreshChannels();
      await refreshDashboard();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "保存监控目标失败"), "error");
    } finally {
      setSavingChannel(false);
    }
  }

  async function deleteChannel(id: string): Promise<void> {
    const channelName = channels.find((item) => item.id === id)?.name || "该监控目标";
    if (!window.confirm(`确定删除“${channelName}”吗？`)) {
      return;
    }

    setRowAction({ type: "delete", id });
    setFeedbackState("正在删除监控目标...", "pending");

    try {
      await api(`/channels/${id}`, { method: "DELETE" });
      setFeedbackState("监控目标已删除。", "success");
      await refreshChannels();
      await refreshDashboard();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "删除监控目标失败"), "error");
    } finally {
      setRowAction(null);
    }
  }

  async function syncChannel(id: string): Promise<void> {
    const channelName = channels.find((item) => item.id === id)?.name || "该监控目标";
    setRowAction({ type: "sync", id });
    setFeedbackState("正在巡检该监控目标...", "pending");

    try {
      const result = await api<{ processed: number }>(`/channels/${id}/check`, { method: "POST" });
      setFeedbackState(
        result.processed > 0 ? `${channelName} 发现了 1 个新视频并已处理。` : `${channelName} 没有更新视频。`,
        "success"
      );
      await refreshAll();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "目标巡检失败"), "error");
    } finally {
      setRowAction(null);
    }
  }

  async function syncNow(): Promise<void> {
    setSyncingAll(true);
    setFeedbackState("正在执行全量巡检，请稍候...", "pending");

    try {
      await api("/actions/sync-now", { method: "POST" });
      const latestDashboard = await api<DashboardResponse>("/dashboard");
      setDashboard(latestDashboard);
      setFeedbackState(`全量巡检完成：${latestDashboard.lastRunOutcome || "已完成"}`, "success");
      await Promise.allSettled([refreshChannels(), refreshRecentHistory(), refreshHistory(historyPage), refreshLogs(logPage), refreshDiagnostics()]);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "全量巡检失败"), "error");
    } finally {
      setSyncingAll(false);
    }
  }

  async function saveSettingsAction(): Promise<void> {
    setSavingSettings(true);
    setFeedbackState("正在保存设置...", "pending");

    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettingsDirty(false);
      setFeedbackState("设置已保存。头像显示开关也需要保存后才会生效。", "success");
      await refreshSettings();
      await refreshDashboard();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "保存设置失败"), "error");
    } finally {
      setSavingSettings(false);
    }
  }

  async function testAiAction(): Promise<void> {
    setTestingAi(true);
    setFeedbackState("正在测试 AI 接口可用性...", "pending");

    try {
      const result = await api<{ message: string }>("/actions/test-ai", { method: "POST" });
      setFeedbackState(result.message, "success");
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "AI 接口测试失败"), "error");
    } finally {
      setTestingAi(false);
    }
  }

  async function testTelegram(): Promise<void> {
    setTestingTelegram(true);
    setFeedbackState("正在发送 Telegram 测试消息...", "pending");

    try {
      await api("/actions/test-telegram", { method: "POST" });
      setFeedbackState("测试消息已发送，请检查 Telegram。", "success");
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "Telegram 测试失败"), "error");
    } finally {
      setTestingTelegram(false);
    }
  }

  async function clearAvatarCacheAction(): Promise<void> {
    setClearingAvatarCache(true);
    setFeedbackState("正在清除头像缓存...", "pending");

    try {
      const result = await api<{ cleared: number }>("/actions/clear-avatar-cache", { method: "POST" });
      setFeedbackState(`头像缓存已清除，共移除 ${result.cleared} 个缓存文件。如需头像，请手动点击“重新获取头像”。`, "success");
      await refreshChannels();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "清除头像缓存失败"), "error");
    } finally {
      setClearingAvatarCache(false);
    }
  }

  async function refreshAvatarsAction(): Promise<void> {
    setRefreshingAvatars(true);
    setFeedbackState("正在重新获取头像缓存...", "pending");

    try {
      const result = await api<{ updated: number; failed: number; skipped: number }>("/actions/refresh-avatars", { method: "POST" });
      setFeedbackState(`头像刷新完成：成功 ${result.updated}，失败 ${result.failed}，跳过 ${result.skipped}。`, "success");
      await refreshChannels();
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "重新获取头像失败"), "error");
    } finally {
      setRefreshingAvatars(false);
    }
  }

  async function runDiagnostics(): Promise<void> {
    setRunningDiagnostics(true);
    setFeedbackState("正在执行网络诊断...", "pending");

    try {
      setDiagnostics(await api<DiagnosticsResponse>("/diagnostics/run", { method: "POST" }));
      setFeedbackState("诊断已更新。", "success");
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "运行诊断失败"), "error");
    } finally {
      setRunningDiagnostics(false);
    }
  }

  async function cleanupHistory(): Promise<void> {
    setCleaningHistory(true);
    setFeedbackState(`正在按“${formatRetentionLabel(settings.history.retentionDays)}”清理历史...`, "pending");

    try {
      await api("/history/cleanup", {
        method: "POST",
        body: JSON.stringify({ days: settings.history.retentionDays })
      });
      setFeedbackState("历史记录已按当前保留范围清理。", "success");
      setHistoryPage(1);
      await Promise.allSettled([refreshHistory(1), refreshRecentHistory(), refreshDashboard()]);
    } catch (error) {
      setFeedbackState(getErrorMessage(error, "清理历史失败"), "error");
    } finally {
      setCleaningHistory(false);
    }
  }

  function setFeedbackState(message: string, tone: FeedbackTone): void {
    setFeedback({ message, tone });
  }

  const sortedChannels = sortChannels(channels, channelSort);
  const pagedChannels = paginateItems(sortedChannels, channelPage, CHANNEL_PAGE_SIZE);
  const historyPageCount = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const logPageCount = Math.max(1, Math.ceil(logTotal / LOG_PAGE_SIZE));

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedChannels.length / CHANNEL_PAGE_SIZE));
    if (channelPage > maxPage) {
      setChannelPage(maxPage);
    }
  }, [channelPage, sortedChannels.length]);

  useEffect(() => {
    if (historyPage > historyPageCount) {
      setHistoryPage(historyPageCount);
      void refreshHistory(historyPageCount);
    }
  }, [historyPage, historyPageCount]);

  useEffect(() => {
    if (logPage > logPageCount) {
      setLogPage(logPageCount);
      void refreshLogs(logPageCount);
    }
  }, [logPage, logPageCount]);

  return (
    <div className="youtube-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            <span className="brand-play" />
          </div>
          <div className="brand-copy">
            <strong>油管哨兵</strong>
            <p>YouTube Sentinel</p>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="主菜单">
          {(Object.keys(PAGE_META) as PageKey[]).map((key) => (
            <SidebarNavButton key={key} active={page === key} label={PAGE_META[key].label} onClick={() => setPage(key)} />
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="sidebar-status-header">
            <h2>当前状态</h2>
            <span>后台信息</span>
          </div>
          <SidebarStatusCard label="后台状态" value={getWorkerStatusText(dashboard)} hint={getWorkerHint(dashboard)} />
          <SidebarStatusCard label="执行频率" value={dashboard ? `${dashboard.intervalMinutes} 分钟` : "--"} />
          <SidebarStatusCard label="下次执行" value={formatLocal(dashboard?.nextRunAt ?? null)} />
          <SidebarStatusCard label="工作时间段" value={normalizeWorkWindowLabel(dashboard?.workWindowLabel)} />
          <SidebarStatusCard label="最近反馈" value={feedback.message} tone={feedback.tone} multiline />
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-copy">
            <h1>{pageMeta.title}</h1>
            <p>{pageMeta.desc}</p>
          </div>
          <div className="topbar-tools">
            <div className="topbar-actions">
              <FeedbackPill tone={feedback.tone} message={feedback.message} />
              {channelAddDetail ? (
                <button className="soft-button detail-toggle" onClick={() => setChannelAddDetailOpen((value) => !value)}>
                  {channelAddDetailOpen ? "收起详情" : "查看详情"}
                </button>
              ) : null}
              <button className="primary-button" disabled={syncingAll} onClick={() => void syncNow()}>
                {syncingAll ? "巡检中..." : "立即巡检"}
              </button>
            </div>
            {channelAddDetail && channelAddDetailOpen ? (
              <div className="detail-popover">
                <div className="detail-popover-header">
                  <strong>添加结果详情</strong>
                  <button className="detail-close" type="button" onClick={() => setChannelAddDetailOpen(false)}>
                    关闭
                  </button>
                </div>
                <div className="detail-popover-body">
                  {channelAddDetail.added.length > 0 ? (
                    <DetailBlock title={`新增成功 ${channelAddDetail.added.length} 项`} items={channelAddDetail.added} tone="success" />
                  ) : null}
                  {channelAddDetail.duplicates.length > 0 ? (
                    <DetailBlock title={`重复已跳过 ${channelAddDetail.duplicates.length} 项`} items={channelAddDetail.duplicates} tone="muted" />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </header>

        <main className="workspace-content">
          {page === "overview" && (
            <div className="page-grid">
              <section className="surface-card">
                <div className="surface-card-header">
                  <div>
                    <h2>运行概况</h2>
                    <p>最核心的运行指标固定放在首页。</p>
                  </div>
                </div>
                <div className="summary-grid">
                  <SummaryCard label="监控目标" value={String(dashboard?.channelCount ?? channels.length)} />
                  <SummaryCard label="历史条目" value={String(dashboard?.historyCount ?? historyTotal)} />
                  <SummaryCard label="上次执行" value={formatLocal(dashboard?.lastRunAt ?? null)} />
                  <SummaryCard label="最近结果" value={dashboard?.lastRunOutcome ?? "等待首次巡检"} multiline />
                </div>
              </section>

              <section className="surface-card">
                <div className="surface-card-header">
                  <div>
                    <h2>最近推送</h2>
                    <p>显示最近 5 条历史，快速确认推送链路是否正常。</p>
                  </div>
                </div>
                <div className="surface-card-body">
                  {recentHistory.length === 0 ? <EmptyState text="暂时还没有推送历史。" /> : <HistoryList items={recentHistory} />}
                </div>
              </section>
            </div>
          )}

          {page === "channels" && (
            <div className="page-grid channel-stack">
              <section className="surface-card channel-form-card">
                <div className="surface-card-header">
                  <div>
                    <h2>{isEditingChannel ? "编辑目标" : "添加目标"}</h2>
                    <p>{isEditingChannel ? "更新当前目标的链接和显示名称。" : "支持多行批量添加，也支持“链接 | 名称”。"}</p>
                  </div>
                </div>
                <div className="surface-card-body">
                  {isEditingChannel ? (
                    <div className="form-stack">
                      <FieldBlock label="频道链接">
                        <input
                          value={channelForm.originalUrl}
                          onChange={(event) => setChannelForm((prev) => ({ ...prev, originalUrl: event.target.value }))}
                          placeholder="https://www.youtube.com/@channel/videos"
                        />
                      </FieldBlock>
                      <FieldBlock label="显示名称">
                        <input
                          value={channelForm.name}
                          onChange={(event) => setChannelForm((prev) => ({ ...prev, name: event.target.value }))}
                          placeholder="可选"
                        />
                      </FieldBlock>
                    </div>
                  ) : (
                    <div className="form-stack">
                      <FieldBlock label="目标链接">
                        <textarea
                          value={channelForm.batchInput}
                          onChange={(event) =>
                            setChannelForm((prev) => ({
                              ...prev,
                              batchInput: normalizeBatchInput(event.target.value)
                            }))
                          }
                          onPaste={(event) => {
                            const pastedText = event.clipboardData.getData("text");
                            if (!pastedText) {
                              return;
                            }

                            event.preventDefault();
                            const target = event.currentTarget;
                            const start = target.selectionStart ?? target.value.length;
                            const end = target.selectionEnd ?? start;
                            const nextValue =
                              target.value.slice(0, start) +
                              formatPastedBatchInput(pastedText) +
                              target.value.slice(end);

                            setChannelForm((prev) => ({
                              ...prev,
                              batchInput: normalizeBatchInput(nextValue)
                            }));
                          }}
                          placeholder={"每行一个链接\n支持格式：链接 | 名称\nhttps://www.youtube.com/@openai/videos\nhttps://www.youtube.com/@GoogleDevelopers/videos | Google Developers"}
                        />
                        <small>每次粘贴一个链接后会自动换行。建议直接填频道的 videos 页面链接。</small>
                      </FieldBlock>
                      <FieldBlock label="统一显示名称">
                        <input
                          value={channelForm.name}
                          onChange={(event) => setChannelForm((prev) => ({ ...prev, name: event.target.value }))}
                          placeholder="仅单条添加时生效，可选"
                        />
                      </FieldBlock>
                    </div>
                  )}

                  <div className="button-row">
                    <button className="primary-button" disabled={savingChannel} onClick={() => void saveChannel()}>
                      {savingChannel ? (isEditingChannel ? "保存中..." : "添加中...") : isEditingChannel ? "保存修改" : "添加目标"}
                    </button>
                    <button className="soft-button" disabled={savingChannel} onClick={() => setChannelForm(EMPTY_CHANNEL_FORM)}>
                      清空
                    </button>
                  </div>
                </div>
              </section>

              <section className="surface-card">
                <div className="surface-card-header compact-head">
                  <div className="list-head-block">
                    <h2>目标列表</h2>
                    <p>共 {channels.length} 个目标。</p>
                  </div>
                  <div className="panel-tools">
                    <select
                      className="compact-select"
                      value={channelSort}
                      onChange={(event) => {
                        setChannelSort(event.target.value as ChannelSortKey);
                        setChannelPage(1);
                      }}
                    >
                      <option value="latest">最新添加在前</option>
                      <option value="oldest">最早添加在前</option>
                      <option value="name_asc">名称 A-Z</option>
                      <option value="checked_desc">最近检查在前</option>
                    </select>
                  </div>
                </div>
                <div className="surface-card-body">
                  {channels.length === 0 ? (
                    <EmptyState text="还没有监控目标。" />
                  ) : (
                    <div className="youtube-list">
                      {pagedChannels.map((channel) => {
                        const syncingThis = rowAction?.type === "sync" && rowAction.id === channel.id;
                        const deletingThis = rowAction?.type === "delete" && rowAction.id === channel.id;

                        return (
                          <article key={channel.id} className="youtube-row">
                            <div className="row-leading">
                              <ChannelAvatar channel={channel} enabled={settings.ui.showChannelAvatars} />
                              <div className="row-copy">
                                <h3>{channel.name || "未命名目标"}</h3>
                                <p>{channel.originalUrl}</p>
                                <div className="row-meta">
                                  <span>上次检查：{formatLocal(channel.lastCheckedAt)}</span>
                                  {channel.lastError ? <span className="meta-error">错误：{channel.lastError}</span> : null}
                                </div>
                              </div>
                            </div>
                            <div className="row-actions">
                              <button
                                className="soft-button"
                                disabled={Boolean(rowAction) || savingChannel}
                                onClick={() => setChannelForm({ id: channel.id, originalUrl: channel.originalUrl, name: channel.name, batchInput: "" })}
                              >
                                编辑
                              </button>
                              <button className="soft-button" disabled={Boolean(rowAction)} onClick={() => void syncChannel(channel.id)}>
                                {syncingThis ? "检查中..." : "立即检查"}
                              </button>
                              <button className="danger-button" disabled={Boolean(rowAction)} onClick={() => void deleteChannel(channel.id)}>
                                {deletingThis ? "删除中..." : "删除"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <Pagination
                    currentPage={channelPage}
                    totalItems={sortedChannels.length}
                    pageSize={CHANNEL_PAGE_SIZE}
                    onPageChange={setChannelPage}
                  />
                </div>
              </section>
            </div>
          )}

          {page === "history" && (
            <div className="page-grid">
              <section className="surface-card">
                <div className="surface-card-header compact-head">
                  <div>
                    <h2>推送历史</h2>
                    <p>当前共有 {historyTotal} 条记录。</p>
                  </div>
                </div>
                <div className="surface-card-body">
                  {history.length === 0 ? <EmptyState text="还没有历史记录。" /> : <HistoryList items={history} />}
                  <Pagination
                    currentPage={historyPage}
                    totalItems={historyTotal}
                    pageSize={HISTORY_PAGE_SIZE}
                    onPageChange={(pageNumber) => {
                      setHistoryPage(pageNumber);
                    }}
                  />
                </div>
              </section>
            </div>
          )}

          {page === "logs" && (
            <div className="page-grid">
              <section className="surface-card">
                <div className="surface-card-header compact-head">
                  <div>
                    <h2>执行日志</h2>
                    <p>当前共有 {logTotal} 条记录，包含手动执行和定时执行的详细结果。</p>
                  </div>
                </div>
                <div className="surface-card-body">
                  {logs.length === 0 ? <EmptyState text="还没有执行日志。" /> : <LogList items={logs} />}
                  <Pagination
                    currentPage={logPage}
                    totalItems={logTotal}
                    pageSize={LOG_PAGE_SIZE}
                    onPageChange={(pageNumber) => {
                      setLogPage(pageNumber);
                    }}
                  />
                </div>
              </section>
            </div>
          )}

          {page === "settings" && (
            <div className="page-grid settings-grid">
              <section className="surface-card settings-toolbar settings-card-wide">
                <div className="surface-card-header split-header settings-toolbar-header">
                  <div>
                    <h2>设置变更</h2>
                    <p className={settingsDirty ? "settings-warning-text" : undefined}>
                      {settingsDirty ? "有未保存变更，点击右侧按钮后才会写入并按规则生效。" : "所有设置已保存，具体生效时机会继续通过右上角提示展示。"}
                    </p>
                  </div>
                  <button className="primary-button" disabled={savingSettings || !settingsDirty} onClick={() => void saveSettingsAction()}>
                    {savingSettings ? "保存中..." : "保存设置"}
                  </button>
                </div>
              </section>
              <section className="surface-card settings-card-surface">
                <div className="surface-card-header">
                  <div>
                    <h2>监控设置</h2>
                    <p>控制执行频率、工作时间段，并保存到后台调度器。</p>
                  </div>
                  <button className="primary-button" disabled={savingSettings || !settingsDirty} onClick={() => void saveSettingsAction()}>
                    {savingSettings ? "保存中..." : "保存全部设置"}
                  </button>
                </div>
                <div className="surface-card-banner">
                  {settingsDirty ? "有未保存变更，点击右上角保存后才会写入并按规则生效。" : "所有设置已保存，具体生效时机会继续通过右上角提示展示。"}
                </div>
                <div className="surface-card-body settings-form-grid">
                  <FieldBlock label="巡检频率（分钟）">
                    <select
                      value={String(settings.monitor.intervalMinutes)}
                      onChange={(event) =>
                        updateSettingsDraft((prev) => ({
                          ...prev,
                          monitor: { ...prev.monitor, intervalMinutes: Number(event.target.value) }
                        }))
                      }
                    >
                      {[...INTERVAL_PRESETS, settings.monitor.intervalMinutes]
                        .filter((value, index, array) => array.indexOf(value) === index)
                        .sort((a, b) => a - b)
                        .map((value) => (
                          <option key={value} value={value}>
                            {value} 分钟
                          </option>
                        ))}
                    </select>
                  </FieldBlock>
                  <FieldBlock label="启用工作时间段">
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={settings.monitor.workWindow.enabled}
                        onChange={(event) =>
                          updateSettingsDraft((prev) => ({
                            ...prev,
                            monitor: {
                              ...prev.monitor,
                              workWindow: { ...prev.monitor.workWindow, enabled: event.target.checked }
                            }
                          }))
                        }
                      />
                      <span>{settings.monitor.workWindow.enabled ? "已启用" : "未启用"}</span>
                    </label>
                    <small>仅在该时间段内执行巡检与推送。</small>
                  </FieldBlock>
                  <FieldBlock label="开始时间">
                    <input
                      type="time"
                      value={settings.monitor.workWindow.start}
                      onChange={(event) =>
                        updateSettingsDraft((prev) => ({
                          ...prev,
                          monitor: {
                            ...prev.monitor,
                            workWindow: { ...prev.monitor.workWindow, start: event.target.value }
                          }
                        }))
                      }
                    />
                  </FieldBlock>
                  <FieldBlock label="结束时间">
                    <input
                      type="time"
                      value={settings.monitor.workWindow.end}
                      onChange={(event) =>
                        updateSettingsDraft((prev) => ({
                          ...prev,
                          monitor: {
                            ...prev.monitor,
                            workWindow: { ...prev.monitor.workWindow, end: event.target.value }
                          }
                        }))
                      }
                    />
                  </FieldBlock>
                </div>
              </section>

              <section className="surface-card settings-card-surface">
                <div className="surface-card-header">
                  <div>
                    <h2>AI 设置</h2>
                    <p>配置摘要接口、模型，并实时测试接口可用性。</p>
                  </div>
                </div>
                <div className="surface-card-body settings-form-grid">
                  <FieldBlock label="AI Base URL">
                    <input value={settings.ai.baseUrl} onChange={(event) => updateSettingsDraft((prev) => ({ ...prev, ai: { ...prev.ai, baseUrl: event.target.value } }))} />
                  </FieldBlock>
                  <FieldBlock label="AI 模型">
                    <input value={settings.ai.model} onChange={(event) => updateSettingsDraft((prev) => ({ ...prev, ai: { ...prev.ai, model: event.target.value } }))} />
                  </FieldBlock>
                  <SensitiveField
                    label="AI API Key"
                    value={settings.ai.apiKey}
                    visible={secretVisibility.aiApiKey}
                    placeholder="请输入 AI API Key"
                    onChange={(value) => updateSettingsDraft((prev) => ({ ...prev, ai: { ...prev.ai, apiKey: value } }))}
                    onToggle={() => setSecretVisibility((prev) => ({ ...prev, aiApiKey: !prev.aiApiKey }))}
                  />
                </div>
                <div className="surface-card-footer">
                  <button className="soft-button" disabled={testingAi} onClick={() => void testAiAction()}>
                    {testingAi ? "测试中..." : "测试 AI 接口"}
                  </button>
                </div>
              </section>

              <section className="surface-card settings-card-surface">
                <div className="surface-card-header">
                  <div>
                    <h2>Telegram 推送</h2>
                    <p>配置推送机器人，并直接发送测试消息验证连通性。</p>
                  </div>
                </div>
                <div className="surface-card-body settings-form-grid">
                  <SensitiveField
                    label="Telegram Bot Token"
                    value={settings.telegram.botToken}
                    visible={secretVisibility.telegramBotToken}
                    placeholder="请输入 Telegram Bot Token"
                    onChange={(value) => updateSettingsDraft((prev) => ({ ...prev, telegram: { ...prev.telegram, botToken: value } }))}
                    onToggle={() => setSecretVisibility((prev) => ({ ...prev, telegramBotToken: !prev.telegramBotToken }))}
                  />
                  <SensitiveField
                    label="Telegram Chat ID"
                    value={settings.telegram.chatId}
                    visible={secretVisibility.telegramChatId}
                    placeholder="请输入 Telegram Chat ID"
                    onChange={(value) => updateSettingsDraft((prev) => ({ ...prev, telegram: { ...prev.telegram, chatId: value } }))}
                    onToggle={() => setSecretVisibility((prev) => ({ ...prev, telegramChatId: !prev.telegramChatId }))}
                  />
                </div>
                <div className="surface-card-footer">
                  <button className="soft-button" disabled={testingTelegram} onClick={() => void testTelegram()}>
                    {testingTelegram ? "发送中..." : "测试 Telegram"}
                  </button>
                </div>
              </section>

              <section className="surface-card settings-card-surface">
                <div className="surface-card-header">
                  <div>
                    <h2>界面设置</h2>
                    <p>控制目标列表是否显示作者头像。开关只影响显示，头像获取需要你手动触发。</p>
                  </div>
                </div>
                <div className="surface-card-body settings-form-grid">
                  <FieldBlock label="显示作者头像">
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={settings.ui.showChannelAvatars}
                        onChange={(event) =>
                          updateSettingsDraft((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, showChannelAvatars: event.target.checked }
                          }))
                        }
                      />
                      <span>{settings.ui.showChannelAvatars ? "已启用" : "默认 logo"}</span>
                    </label>
                  </FieldBlock>
                  <div className="history-inline-card">
                    <span>头像缓存</span>
                    <strong>{settings.ui.showChannelAvatars ? "显示已启用" : "当前使用默认 logo"}</strong>
                  </div>
                </div>
                <div className="surface-card-footer">
                  <button className="soft-button" disabled={refreshingAvatars} onClick={() => void refreshAvatarsAction()}>
                    {refreshingAvatars ? "获取中..." : "重新获取头像"}
                  </button>
                  <button className="soft-button" disabled={clearingAvatarCache} onClick={() => void clearAvatarCacheAction()}>
                    {clearingAvatarCache ? "清理中..." : "清除头像缓存"}
                  </button>
                </div>
              </section>

              <section className="surface-card settings-card-surface">
                <div className="surface-card-header">
                  <div>
                    <h2>历史记录设置</h2>
                    <p>历史清理入口移到这里，并保留范围选项。</p>
                  </div>
                </div>
                <div className="surface-card-body settings-form-grid">
                  <FieldBlock label="历史保留时间范围">
                    <select
                      value={String(settings.history.retentionDays)}
                      onChange={(event) => updateSettingsDraft((prev) => ({ ...prev, history: { ...prev.history, retentionDays: Number(event.target.value) } }))}
                    >
                      {HISTORY_CLEANUP_OPTIONS.map((option) => (
                        <option key={option.days} value={option.days}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </FieldBlock>
                  <div className="history-inline-card">
                    <span>数据条目</span>
                    <strong>{historyTotal}</strong>
                  </div>
                </div>
                <div className="surface-card-footer">
                  <button className="soft-button" disabled={cleaningHistory} onClick={() => void cleanupHistory()}>
                    {cleaningHistory ? "清理中..." : "清除历史记录"}
                  </button>
                </div>
              </section>

              <section className="surface-card settings-card-surface settings-card-wide">
                <div className="surface-card-header split-header">
                  <div>
                    <h2>网络诊断</h2>
                    <p>外网测试只展示可读摘要，不再暴露原始网页源码。</p>
                  </div>
                  <button className="soft-button" disabled={runningDiagnostics} onClick={() => void runDiagnostics()}>
                    {runningDiagnostics ? "诊断中..." : "运行诊断"}
                  </button>
                </div>
                <div className="surface-card-body diagnostic-stack">
                  {diagnostics && diagnostics.items.length > 0 ? (
                    <div className="diagnostic-list">
                      {diagnostics.items.map((item) => (
                        <DiagnosticRow key={item.name} item={item} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState text="还没有诊断结果，点击右上角按钮即可运行。" />
                  )}
                </div>
              </section>
            </div>
          )}
        </main>

        <footer className="workspace-footer">
          <span>油管哨兵 v{window.desktop?.version || packageInfo.version || "--"}</span>
          <span>监控 YouTube 目标、生成摘要并推送到 Telegram。</span>
        </footer>
      </div>
    </div>
  );
}

function SidebarNavButton(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? "sidebar-nav-item active" : "sidebar-nav-item"} onClick={props.onClick}>
      <span>{props.label}</span>
    </button>
  );
}

function SidebarStatusCard(props: { label: string; value: string; hint?: string; tone?: FeedbackTone; multiline?: boolean }) {
  return (
    <article className={props.multiline ? "sidebar-status-card multiline" : "sidebar-status-card"}>
      <span>{props.label}</span>
      <strong className={props.tone ? `tone-${props.tone}` : undefined}>{props.value}</strong>
      {props.hint ? <small>{props.hint}</small> : null}
    </article>
  );
}

function ChannelAvatar(props: { channel: Channel; enabled: boolean }) {
  const [failed, setFailed] = useState(false);
  const avatarVersion = props.channel.avatarUpdatedAt ?? "";
  const avatarSrc = `${API_BASE}/channels/${props.channel.id}/avatar${avatarVersion ? `?v=${encodeURIComponent(avatarVersion)}` : ""}`;

  useEffect(() => {
    setFailed(false);
  }, [props.channel.id, props.enabled, avatarVersion]);

  if (!props.enabled || !props.channel.avatarUpdatedAt || failed) {
    return <div className="row-avatar">▶</div>;
  }

  return (
    <div className="row-avatar avatar-image-wrap">
      <img
        className="channel-avatar-image"
        src={avatarSrc}
        alt={props.channel.name}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function FeedbackPill(props: { tone: FeedbackTone; message: string }) {
  return (
    <div className={`feedback-pill ${props.tone}`}>
      <span className="feedback-dot" />
      <span>{props.message}</span>
    </div>
  );
}

function DetailBlock(props: { title: string; items: string[]; tone: "success" | "muted" }) {
  return (
    <section className="detail-block">
      <div className="detail-block-title">
        <span className={props.tone === "success" ? "detail-dot success" : "detail-dot muted"} />
        <strong>{props.title}</strong>
      </div>
      <div className="detail-text">{props.items.join("\n")}</div>
    </section>
  );
}

function SummaryCard(props: { label: string; value: string; multiline?: boolean }) {
  return (
    <article className={props.multiline ? "summary-card multiline" : "summary-card"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  );
}

function FieldBlock(props: { label: string; children: ReactNode }) {
  return (
    <label className="field-block">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function SensitiveField(props: {
  label: string;
  value: string;
  visible: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onToggle: () => void;
}) {
  return (
    <label className="field-block sensitive-field">
      <span>{props.label}</span>
      <div className="sensitive-row">
        <input type={props.visible ? "text" : "password"} value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} />
        <button type="button" className="soft-button sensitive-toggle" onClick={props.onToggle}>
          {props.visible ? "隐藏" : "显示"}
        </button>
      </div>
      <small>{props.visible ? "当前为明文显示" : `当前已掩码：${maskSecret(props.value) || "空"}`}</small>
    </label>
  );
}

function HistoryList(props: { items: HistoryRecord[] }) {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  return (
    <div className="youtube-list history-list">
      {props.items.map((item) => {
        const expanded = Boolean(expandedMap[item.id]);
        const preview = getHistoryPreview(item);

        return (
          <article key={item.id} className={expanded ? "history-row expanded" : "history-row"}>
            <button
              type="button"
              className="history-row-button"
              onClick={() => setExpandedMap((prev) => ({ ...prev, [item.id]: !expanded }))}
            >
              <div className="history-row-main">
                <div className="history-row-title">
                  <span className="history-author">{preview.author}</span>
                  <span className="history-divider">/</span>
                  <span className="history-title-text">{preview.title}</span>
                </div>
                <div className="history-row-meta">
                  <span className={`history-result ${item.status}`}>{getHistoryStatusLabel(item.status)}</span>
                  <span>{formatLocal(item.createdAt)}</span>
                </div>
              </div>
              <span className={expanded ? "history-chevron expanded" : "history-chevron"}>⌄</span>
            </button>
            <div className={expanded ? "history-panel expanded" : "history-panel"}>
              <div className="history-panel-inner">{item.summary}</div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LogList(props: { items: LogRecord[] }) {
  return (
    <div className="log-list">
      {props.items.map((item) => (
        <article key={item.id} className="log-row">
          <div className="log-row-main">
            <div className="log-row-top">
              <span className={`log-badge ${item.status}`}>{getLogStatusLabel(item.status)}</span>
              <span className="log-source">{getLogSourceLabel(item.source)}</span>
              <span>{formatLocal(item.createdAt)}</span>
            </div>
            <div className="log-message">{item.message}</div>
          </div>
        </article>
      ))}
    </div>
  );
}

function DiagnosticRow(props: { item: DiagnosticStatus }) {
  return (
    <article className="diagnostic-row">
      <div>
        <h3>{props.item.name}</h3>
        <p>{formatDiagnosticDetail(props.item.detail)}</p>
      </div>
      <div className="diagnostic-meta">
        <span>{getDiagnosticStatusLabel(props.item.status)}</span>
        <span>{props.item.durationMs} ms</span>
        <span>{formatLocal(props.item.checkedAt)}</span>
      </div>
    </article>
  );
}

function EmptyState(props: { text: string }) {
  return <div className="empty-state">{props.text}</div>;
}

function Pagination(props: {
  currentPage: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (pageNumber: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(props.totalItems / props.pageSize));
  if (props.totalItems <= props.pageSize) {
    return null;
  }

  const pages = buildPageNumbers(props.currentPage, totalPages);

  return (
    <div className="pagination">
      <button className="pagination-button" disabled={props.currentPage <= 1} onClick={() => props.onPageChange(props.currentPage - 1)}>
        上一页
      </button>
      <div className="pagination-pages">
        {pages.map((pageNumber) => (
          <button
            key={pageNumber}
            className={pageNumber === props.currentPage ? "pagination-number active" : "pagination-number"}
            onClick={() => props.onPageChange(pageNumber)}
          >
            {pageNumber}
          </button>
        ))}
      </div>
      <button
        className="pagination-button"
        disabled={props.currentPage >= totalPages}
        onClick={() => props.onPageChange(props.currentPage + 1)}
      >
        下一页
      </button>
    </div>
  );
}

function parseBatchEntries(input: string, fallbackName: string): Array<{ originalUrl: string; name: string }> {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const [urlPart, ...nameParts] = line.split("|");
    const originalUrl = urlPart.trim();
    const inlineName = nameParts.join("|").trim();
    return { originalUrl, name: inlineName || (lines.length === 1 ? fallbackName.trim() : "") };
  });
}

function normalizeBatchInput(value: string): string {
  return value
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [""];
      }

      if (trimmed.includes("|")) {
        return [trimmed];
      }

      const urls = trimmed.match(/https?:\/\/\S+/g);
      if (urls && urls.length > 1) {
        return urls;
      }

      return [trimmed];
    })
    .join("\n");
}

function formatPastedBatchInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const normalized = normalizeBatchInput(trimmed);
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function formatDuplicateDetails(items: string[]): string {
  if (items.length <= 3) {
    return items.join("，");
  }

  return `${items.slice(0, 3).join("，")} 等 ${items.length} 项`;
}

function getWorkerStatusText(dashboard: DashboardResponse | null): string {
  if (!dashboard) {
    return "后台未连接";
  }
  switch (dashboard.workerStatus) {
    case "running":
      return "运行中";
    case "stopped":
      return "已停止";
    case "task_registered":
      return "已注册";
    case "task_missing":
      return "运行中";
    default:
      return dashboard.workerStatus;
  }
}

function getWorkerHint(dashboard: DashboardResponse | null): string | undefined {
  if (!dashboard) {
    return "请先启动 dev-worker.bat";
  }
  return dashboard.taskRegistered ? "已注册开机自启任务" : "未注册开机自启任务";
}

function normalizeWorkWindowLabel(value: string | undefined): string {
  if (!value || value === "È«Ìì") {
    return "全天";
  }
  return value.toLowerCase() === "all day" ? "全天" : value;
}

function formatDiagnosticDetail(detail: string): string {
  if (/<[a-z!/][^>]*>/i.test(detail)) {
    return "旧缓存里包含原始网页内容，请点击“运行诊断”刷新为可读摘要。";
  }
  return detail;
}

function getDiagnosticStatusLabel(status: DiagnosticStatus["status"]): string {
  if (status === "ok") {
    return "正常";
  }
  if (status === "timeout") {
    return "超时";
  }
  return "错误";
}

function getHistoryStatusLabel(status: string): string {
  if (status === "success") {
    return "推送成功";
  }
  if (status === "failed") {
    return "推送失败";
  }
  return status;
}

function getLogStatusLabel(status: LogRecord["status"]): string {
  if (status === "success") {
    return "成功";
  }
  if (status === "error") {
    return "错误";
  }
  return "信息";
}

function getLogSourceLabel(source: LogRecord["source"]): string {
  if (source === "scheduled") {
    return "定时";
  }
  if (source === "manual") {
    return "手动";
  }
  return "系统";
}

function getHistoryPreview(item: HistoryRecord): { author: string; title: string } {
  const firstLine = item.summary.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = firstLine.match(/^\[(.+?)\]\s*(.+)$/);

  if (match) {
    return {
      author: match[1],
      title: item.title || match[2]
    };
  }

  return {
    author: "未知作者",
    title: item.title
  };
}

function sortChannels(items: Channel[], sortKey: ChannelSortKey): Channel[] {
  const next = [...items];
  switch (sortKey) {
    case "oldest":
      return next.sort((a, b) => parseChannelCreatedAt(a.id) - parseChannelCreatedAt(b.id));
    case "name_asc":
      return next.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    case "checked_desc":
      return next.sort((a, b) => parseDateValue(b.lastCheckedAt) - parseDateValue(a.lastCheckedAt));
    case "latest":
    default:
      return next.sort((a, b) => parseChannelCreatedAt(b.id) - parseChannelCreatedAt(a.id));
  }
}

function paginateItems<T>(items: T[], pageNumber: number, pageSize: number): T[] {
  const offset = (pageNumber - 1) * pageSize;
  return items.slice(offset, offset + pageSize);
}

function parseChannelCreatedAt(id: string): number {
  const parts = id.split("_");
  const timestamp = Number(parts[1] ?? 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseDateValue(value: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildPageNumbers(currentPage: number, totalPages: number): number[] {
  const pages = new Set<number>([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  return [...pages].filter((item) => item >= 1 && item <= totalPages).sort((a, b) => a - b);
}

function formatRetentionLabel(days: number): string {
  return HISTORY_CLEANUP_OPTIONS.find((item) => item.days === days)?.label ?? `保留最近 ${days} 天`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
