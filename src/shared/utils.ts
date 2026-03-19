export function formatLocal(dateLike: string | null): string {
  if (!dateLike) {
    return "--";
  }

  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }

  if (value.length <= 6) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function workWindowLabel(enabled: boolean, start: string, end: string): string {
  if (!enabled) {
    return "全天";
  }

  return `${start} - ${end}`;
}