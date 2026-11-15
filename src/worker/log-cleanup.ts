import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";

// Snapshot before filtering; concurrent appenders keep their original path.
export async function cleanupTextLogs(logsDir: string, cutoff: string | null): Promise<{ files: number; lines: number; warnings: string[] }> {
  await mkdir(logsDir, { recursive: true });
  if ((await lstat(logsDir)).isSymbolicLink()) throw new Error("日志目录是链接，无法安全清理。");
  const root = resolve(logsDir);
  const inside = (name: string) => {
    const path = resolve(join(root, name));
    if (!path.startsWith(root + sep)) throw new Error("日志路径无效");
    return path;
  };
  const result = { files: 0, lines: 0, warnings: [] as string[] };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const source = inside(entry.name);
    if ((await lstat(source)).size === 0) continue;
    const snapshot = inside(`snapshot-${randomUUID()}.log`);
    const retained = inside(`retained-${randomUUID()}.log`);
    try {
      await rename(source, snapshot);
      if (!/^(?:retained|snapshot)-/.test(entry.name)) {
        try { await writeFile(source, "", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!cutoff) {
        let removed = 0;
        const reader = createInterface({ input: createReadStream(snapshot), crlfDelay: Infinity });
        for await (const line of reader) removed += 1;
        await unlink(snapshot);
        result.files += 1;
        result.lines += removed;
        continue;
      }
      const output = await open(retained, "wx");
      let keep = true;
      let kept = 0;
      let removed = 0;
      let buffer = "";
      try {
        const reader = createInterface({ input: createReadStream(snapshot), crlfDelay: Infinity });
        for await (const line of reader) {
          const timestamp = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/)?.[1];
          if (timestamp && !Number.isNaN(Date.parse(timestamp))) keep = Date.parse(timestamp) >= Date.parse(cutoff);
          if (keep) { buffer += `${line}\n`; kept += 1; } else { removed += 1; }
          if (buffer.length >= 65536) { await output.write(buffer); buffer = ""; }
        }
        if (buffer) await output.write(buffer);
      } finally { await output.close(); }
      if (!kept) await unlink(retained);
      await unlink(snapshot);
      result.files += 1;
      result.lines += removed;
    } catch {
      // Keep original records in the snapshot if filtering fails.
      try { await unlink(retained); } catch { /* No output to remove. */ }
      result.warnings.push(`${entry.name} 未完成清理，原记录已保留。`);
    }
  }
  return result;
}
