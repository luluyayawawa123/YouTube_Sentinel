import type { MonitorSettings } from "@shared/types";

function parseMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isWithinWorkWindow(settings: MonitorSettings, now = new Date()): boolean {
  if (!settings.workWindow.enabled) {
    return true;
  }

  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseMinutes(settings.workWindow.start);
  const end = parseMinutes(settings.workWindow.end);

  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

function computeNextRun(settings: MonitorSettings, from = new Date()): Date {
  const candidate = new Date(from.getTime() + settings.intervalMinutes * 60 * 1000);
  if (!settings.workWindow.enabled) {
    return candidate;
  }

  const startMinutes = parseMinutes(settings.workWindow.start);
  const endMinutes = parseMinutes(settings.workWindow.end);
  const next = new Date(candidate);
  const currentMinutes = next.getHours() * 60 + next.getMinutes();

  if (startMinutes <= endMinutes) {
    if (currentMinutes < startMinutes) {
      next.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    } else if (currentMinutes > endMinutes) {
      next.setDate(next.getDate() + 1);
      next.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    }
  }

  return next;
}

export class PollScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: string | null = null;

  configure(settings: MonitorSettings, onTick: () => Promise<void>): void {
    this.stop();

    const schedule = () => {
      const next = computeNextRun(settings);
      this.nextRunAt = next.toISOString();
      const delay = Math.max(1000, next.getTime() - Date.now());
      this.timer = setTimeout(async () => {
        if (isWithinWorkWindow(settings)) {
          await onTick();
        }
        schedule();
      }, delay);
    };

    schedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  getNextRunAt(): string | null {
    return this.nextRunAt;
  }
}
