import type { CleanupCategory, CleanupResult } from "./types";

export function formatCleanupSummary(result: CleanupResult, category: CleanupCategory, days: number): string {
  const count = (value: number) => value.toLocaleString("zh-CN");
  const selected = (value: CleanupCategory) => category === "all" || category === value;
  const empty = (value: number) => value === 0 ? "（无符合范围的记录）" : "";
  const lines = [
    selected("push") ? `推送记录：删除历史 ${count(result.history)} 条、明细 ${count(result.deliveries)} 条${empty(result.history + result.deliveries)}` : "推送记录：未选择，未清理",
    selected("execution") ? `执行日志：删除 ${count(result.execution)} 条${empty(result.execution)}` : "执行日志：未选择，未清理",
    selected("runtime") ? `文本运行日志：删除 ${count(result.textLines)} 行，处理 ${count(result.textFiles)} 个文件${result.warnings.length ? "" : empty(result.textLines)}` : "文本运行日志：未选择，未清理"
  ];
  if (result.warnings.length) lines.push(`${count(result.warnings.length)} 个文本日志清理失败，原记录已保留。`);
  return lines.join("\n");
}
