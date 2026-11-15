const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function databaseFixture() {
  const exports = {};
  vm.runInNewContext(compile('src/worker/storage.ts'), {
    exports, module: { require }, require: name => name === '@shared/utils' ? { makeId: randomUUID } : require(name)
  });
  const storage = new exports.Storage(':memory:');
  storage.db.exec(`
    INSERT INTO channels (id, original_url, canonical_url, channel_id, name, enabled) VALUES ('c','url','canonical','channel','fixture',1);
    INSERT INTO videos (video_id,channel_id,title,published_at,raw_payload,source_level,process_state,created_at) VALUES
      ('old','c','old','2020-01-01','{}','A','done','2020-01-01'),('new','c','new','2099-01-01','{}','A','done','2099-01-01');
    INSERT INTO history (id,type,title,status,summary,created_at,expire_at) VALUES
      ('h-old','push','old','success','old','2020-01-01','2099-01-01'),('h-new','push','new','success','new','2099-01-01','2099-01-01');
    INSERT INTO deliveries (id,video_id,tg_status,sent_at,retry_count,error_message,message_preview) VALUES
      ('d-fail','old','failed',NULL,1,'error','old failure'),('d-old','old','success','2020-01-01',0,NULL,'old'),('d-new','new','success','2099-01-01',0,NULL,'new');
    INSERT INTO execution_logs (id,source,status,message,created_at) VALUES
      ('l-old','manual','error','old','2020-01-01'),('l-new','scheduled','success','new','2099-01-01');
    UPDATE deliveries SET created_at = '2020-01-01' WHERE id = 'd-fail';
  `);
  return storage;
}

test('legacy auto-retention settings are ignored while manual cleanup ranges are preserved', () => {
  const constants = {};
  const validation = {};
  vm.runInNewContext(compile('src/shared/constants.ts'), { exports: constants });
  vm.runInNewContext(compile('src/shared/validation.ts'), { exports: validation, require });
  const parsed = validation.settingsSchema.parse({ ...constants.DEFAULT_SETTINGS, history: { retentionDays: 1 } });
  assert.equal('history' in parsed, false);
  assert.equal('history' in constants.DEFAULT_SETTINGS, false);
  assert.deepEqual(Array.from(constants.CLEANUP_RANGE_OPTIONS, option => option.days), [0, 7, 30, 90, 365, 1095]);
});

function cleanupSummary(result, category, days) {
  const exports = {};
  vm.runInNewContext(compile('src/shared/cleanup-summary.ts'), { exports });
  return exports.formatCleanupSummary({ history: 0, deliveries: 0, execution: 0, textFiles: 0, textLines: 0, warnings: [], ...result }, category, days);
}

test('cleanup feedback lists all three categories, including zero counts and actual deleted text lines', () => {
  const lines = cleanupSummary({ execution: 76150, textFiles: 1, textLines: 28 }, 'all', 0).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '推送记录：删除历史 0 条、明细 0 条（无符合范围的记录）');
  assert.equal(lines[1], '执行日志：删除 76,150 条');
  assert.equal(lines[2], '文本运行日志：删除 28 行，处理 1 个文件');
});

test('processing a retained text file is not presented as deleting its records', () => {
  const lines = cleanupSummary({ textFiles: 1, textLines: 0 }, 'runtime', 30).split('\n');
  assert.equal(lines[0], '推送记录：未选择，未清理');
  assert.equal(lines[1], '执行日志：未选择，未清理');
  assert.equal(lines[2], '文本运行日志：删除 0 行，处理 1 个文件（无符合范围的记录）');
  assert.match(cleanupSummary({ textFiles: 1, textLines: 12 }, 'runtime', 30), /文本运行日志：删除 12 行，处理 1 个文件/);
});

test('feedback respects the selected category and distinguishes partial cleanup failure', () => {
  assert.equal(cleanupSummary({ history: 2, execution: 9 }, 'push', 30).split('\n')[1], '执行日志：未选择，未清理');
  const message = cleanupSummary({ execution: 3, warnings: ['fixture'] }, 'all', 0);
  assert.match(message, /执行日志：删除 3 条/);
  assert.match(message, /1 个文本日志清理失败，原记录已保留/);
});

test('push retention deletes old history and old failed deliveries while preserving recent logs and deduplication', () => {
  const storage = databaseFixture();
  try {
    const counts = storage.cleanupRecords('push', '2025-01-01T00:00:00Z');
    assert.equal(counts.history, 1);
    assert.equal(counts.deliveries, 2);
    assert.equal(storage.countLogs(), 2);
    assert.equal(storage.hasVideo('old'), true);
    assert.equal(storage.listChannels().length, 1);
  } finally { storage.close(); }
});

test('execution cleanup respects cutoff and never removes push history', () => {
  const storage = databaseFixture();
  try {
    assert.equal(storage.cleanupRecords('execution', '2025-01-01T00:00:00Z').execution, 1);
    assert.equal(storage.countLogs(), 1);
    assert.equal(storage.countHistory(), 2);
  } finally { storage.close(); }
});

test('failed deliveries without a timestamp are preserved rather than dated from an old video', () => {
  const storage = databaseFixture();
  try {
    storage.db.exec("INSERT INTO deliveries (id,video_id,tg_status,sent_at,retry_count,message_preview) VALUES ('unknown','old','failed',NULL,1,'unknown age')");
    storage.cleanupRecords('push', '2025-01-01T00:00:00Z');
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE id='unknown'").get().total, 1);
  } finally { storage.close(); }
});

test('clear all removes the three database record types without removing channels or videos', () => {
  const storage = databaseFixture();
  try {
    const result = storage.cleanupRecords('all', null);
    assert.equal(result.history, 2);
    assert.equal(result.deliveries, 3);
    assert.equal(result.execution, 2);
    assert.equal(storage.hasVideo('new'), true);
    assert.equal(storage.listChannels().length, 1);
  } finally { storage.close(); }
});

function fileFixture(appendDuringRename = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-log-cleanup-'));
  const exports = {};
  const promises = { ...fsp, rename: async (from, to) => {
    await fsp.rename(from, to);
    if (appendDuringRename && path.basename(from) === 'app.log') await fsp.appendFile(from, '[2099-01-02T00:00:00.000Z] concurrent write\n');
  }};
  vm.runInNewContext(compile('src/worker/log-cleanup.ts'), {
    exports, require: name => name === 'node:fs/promises' ? promises : require(name)
  });
  return { directory, api: exports, dispose: () => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  }};
}

test('text cleanup removes old dated records and their continuations, retaining recent and undated content', async () => {
  const fixture = fileFixture();
  try {
    fs.writeFileSync(path.join(fixture.directory, 'app.log'), 'undated heading\n[2020-01-01T00:00:00.000Z] old\nold continuation\n[2099-01-01T00:00:00.000Z] recent\nrecent continuation\n');
    fs.writeFileSync(path.join(fixture.directory, 'keep.json'), '{"keep":true}');
    const result = await fixture.api.cleanupTextLogs(fixture.directory, '2025-01-01T00:00:00Z');
    const combined = fs.readdirSync(fixture.directory).filter(file => file.endsWith('.log')).map(file => fs.readFileSync(path.join(fixture.directory, file), 'utf8')).join('');
    assert.equal(result.lines, 2);
    assert.ok(!combined.includes('old continuation'));
    assert.ok(combined.includes('recent continuation'));
    assert.ok(combined.includes('undated heading'));
    assert.ok(fs.existsSync(path.join(fixture.directory, 'keep.json')));
  } finally { fixture.dispose(); }
});

test('clearing old log snapshots cannot erase new concurrent writes', async () => {
  const fixture = fileFixture(true);
  try {
    fs.writeFileSync(path.join(fixture.directory, 'app.log'), '[2020-01-01T00:00:00.000Z] old\n');
    const result = await fixture.api.cleanupTextLogs(fixture.directory, null);
    assert.equal(result.files, 1);
    assert.equal(result.lines, 1);
    assert.equal(result.warnings.length, 0);
    assert.match(fs.readFileSync(path.join(fixture.directory, 'app.log'), 'utf8'), /concurrent write/);
  } finally { fixture.dispose(); }
});
