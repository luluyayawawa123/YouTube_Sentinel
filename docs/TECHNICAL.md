# 技术文档

本文档面向后续维护者，描述当前工程结构、运行方式、关键链路和常见维护点。

## 1. 工程结构

当前是单仓库 Electron 工程，主要分三层：

- `src/main`
  - Electron 主进程
  - 窗口创建、worker 模式入口、preload 暴露
- `src/renderer`
  - React 前台界面
  - 概览、监控目标、推送历史、执行日志、设置与诊断
- `src/worker`
  - 后台逻辑
  - 本地 HTTP API、巡检、yt-dlp、AI、Telegram、SQLite、计划任务状态读取
- `src/shared`
  - 常量、类型、校验、通用工具

## 2. 运行模式

### 开发版

- `dev-worker.bat`
  - 启动后台
- `dev-ui.bat`
  - 启动前台

开发版前后台严格分离：

- 前台不自动启动后台
- 后台也不自动启动前台

### 打包版

- 主程序：`YouTube Sentinel.exe`
- 后台模式：`YouTube Sentinel.exe --worker`

计划任务注册后，系统启动时会以 `--worker` 模式拉起后台。

## 3. 运行时目录

运行时根目录由下面逻辑决定：

- 打包版：`process.execPath` 所在目录
- 开发版：仓库根目录

运行时目录解析见：

- `src/worker/runtime.ts`

当前目录约定：

- `config/settings.json`
- `data/sentinel.db`
- `data/avatars/`
- `logs/`
- `bin/yt-dlp.exe`

## 4. 核心链路

### 4.1 监控目标添加

目标添加时会调用：

- `resolveChannelInfo()`

处理方式：

1. 用 `yt-dlp --flat-playlist --dump-single-json`
2. 解析频道 ID、频道名
3. 存储：
   - `originalUrl`
   - `canonicalUrl`
   - `channelId`
   - `name`

同时会尝试取频道头像地址，但头像缓存只有在用户主动触发“重新获取头像”时才真正刷新。

### 4.2 定时巡检

后台调度器基于：

- `node-cron`

Windows 计划任务只负责：

- 开机拉起后台 worker

真正巡检节奏由后台内部控制。

工作时间段的含义是：

- 仅在该时间段内执行巡检
- 因为推送依赖巡检，所以效果上也是只在该时间段内推送

### 4.3 新视频发现

当前逻辑是：

1. 针对用户添加的目标链接本身使用 `yt-dlp --flat-playlist`
2. 只抓最新 `1` 条
3. 用 `videoId` 去重

注意：

- 当前每轮每个目标只处理最新 1 个新视频
- 去重主键是 `videos.video_id`

### 4.4 内容提取与 AI 摘要

当前链路：

1. `getVideoMetadata()`
2. 优先提取字幕
3. 无字幕时降级
4. 调用 AI
5. 组装 Telegram 消息

内容优先级：

- `A`
  - 优先用字幕
  - 包括作者字幕和 YouTube 自动字幕
- `B`
  - 没字幕时用简介和章节
- `C`
  - 再不够时用标题和少量元数据

AI 输入目前包含：

- 频道名
- 标题
- 简介
- 章节
- 字幕文本

字幕文本目前会截断到约 `12000` 字符。  
这能控制极端长度，但长视频仍然会显著增加 token 消耗。

### 4.5 Telegram 推送

消息发送在：

- `src/worker/integrations/telegram.ts`

失败会进入重试逻辑，当前是最多 3 次。

发布时间展示已改为：

- 使用后台运行机器的本地系统时区格式化

## 5. 网络与代理

当前后台外网请求包括：

- Telegram
- AI
- YouTube RSS / 视频信息相关请求
- 头像下载
- 网络诊断

当前做法是：

- worker 启动时显式启用 Electron 默认会话的 `system` 代理模式
- 再把全局 `fetch` 切到 `net.fetch`

这样后台默认走系统代理。  
如果用户反馈“只有开 TUN 才能通”，优先排查：

1. 系统代理本身是否可用
2. 代理软件是否对 Electron / Chromium 网络栈生效
3. 目标服务是否被该代理正确放行

## 6. 数据存储

SQLite 在：

- `data/sentinel.db`

主要表：

- `channels`
- `videos`
- `deliveries`
- `history`
- `diagnostics`
- `execution_logs`
- `runtime_state`

存储初始化在：

- `src/worker/storage.ts`

注意：

- `history` 是展示与审计入口
- `videos` 是去重主数据
- 清理历史不会删除频道主数据
- 仅清历史并不能重置“是否已经推送过”的去重状态

## 7. 打包与发布

打包脚本：

- `build-release.bat`

打包流程：

1. 清空 `dist`
2. `npm run build`
3. `npm run package:dir`
4. 将 `electron-builder` 输出整理为最终绿色目录
5. 输出：
   - `dist/YouTube Sentinel`

绿色版根目录必须包含：

- `YouTube Sentinel.exe`
- `register-task.bat`
- `unregister-task.bat`
- `bin`
- `config`
- `data`
- `logs`

## 8. 计划任务

脚本位于：

- `scripts/register-task.bat`
- `scripts/unregister-task.bat`

注册脚本会：

- 以管理员权限执行
- 创建 `YouTube Sentinel Worker`
- 启动方式为：
  - `YouTube Sentinel.exe --worker`
- 使用 `SYSTEM`
- 开机启动
- 失败自动重试

卸载脚本会：

- 停止任务
- 删除任务
- 清理同目录下由 `--worker` 启动的残留后台进程

## 9. 当前维护建议

后续维护时优先注意这些点：

- 不要把开发版和打包版路径逻辑写成两套不一致的规则
- 不要让前台自动拉起后台，当前用户明确要求前后台职责清晰分离
- 打包相关修改必须回归验证：
  - 绿色版启动
  - `register-task.bat`
  - `unregister-task.bat`
  - 重启后后台自动运行
- 与网络相关的改动要同时考虑：
  - 系统代理
  - Telegram
  - AI
  - 诊断
- 与摘要相关的改动要明确告知：
  - 字幕优先
  - token 消耗
  - A/B/C 来源等级
