const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/worker/service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup() {
  const logs = [];
  const channel = { id: 'fixture', name: '测试博主', enabled: true, originalUrl: 'fixture-url', lastVideoAt: null };
  const exports = {};
  const mocks = {
    '@shared/constants': { CLEANUP_RANGE_OPTIONS: [] },
    '@shared/utils': {},
    '@worker/storage': {},
    '@worker/log-cleanup': {},
    '@worker/integrations/ai': {},
    '@worker/integrations/telegram': {},
    '@worker/integrations/youtube-login': { checkYoutubeLogin: async () => {} },
    '@worker/integrations/ytdlp': { fetchLatestTargetEntries: async () => { throw new Error('元数据读取失败测试'); } }
  };
  vm.runInNewContext(source, { exports, Error, require: (name) => {
    if (name.startsWith('node:')) return require(name);
    assert.ok(name in mocks, name);
    return mocks[name];
  }});
  const storage = {
    getChannel: () => channel, listChannels: () => [channel],
    updateChannelRuntime: (id, fields) => Object.assign(channel, fields),
    addLog: (entry) => logs.push(entry),
    setRuntimeValue: () => {}, cleanupExpiredHistory: () => { throw new Error('自动清理已禁用，巡检不能删除历史'); }
  };
  return { service: new exports.WorkerService(storage, {}, {}), logs, channel };
}

test('manual target failure is stored in execution logs and channel state', async () => {
  const { service, logs, channel } = setup();
  await assert.rejects(service.syncSingleChannel(channel.id), /元数据读取失败测试/);
  assert.equal(logs.filter((item) => item.status === 'error').length, 1);
  assert.match(logs.find((item) => item.status === 'error').message, /测试博主：元数据读取失败测试/);
  assert.equal(channel.lastError, '元数据读取失败测试');
});

test('scheduled failures are logged once per target, plus the poll summary', async () => {
  const { service, logs } = setup();
  await service.syncAllChannels('scheduled');
  assert.equal(logs.filter((item) => item.message.includes('测试博主：元数据读取失败测试')).length, 1);
  assert.ok(logs.some((item) => item.status === 'error' && item.message.includes('1 个失败')));
});

function avatarFixture({ existing = null, download = true, resolvedId = 'channel' } = {}) {
  let saved = existing;
  const downloads = [];
  const logs = [];
  const exports = {};
  const mocks = {
    '@shared/constants': { CLEANUP_RANGE_OPTIONS: [] }, '@shared/utils': { makeId: () => 'new-channel' },
    '@worker/storage': {}, '@worker/log-cleanup': {}, '@worker/integrations/ai': {},
    '@worker/integrations/telegram': {}, '@worker/integrations/youtube-login': {},
    '@worker/integrations/ytdlp': { resolveChannelInfo: async () => ({ channelId: resolvedId, channelName: '新博主', canonicalUrl: 'channel-url', avatarUrl: 'https://example.invalid/avatar.jpg' }) }
  };
  vm.runInNewContext(source, { exports, Error, require: name => {
    if (name === 'node:fs') return { ...fs, existsSync: () => true };
    return name.startsWith('node:') ? require(name) : mocks[name];
  }});
  const storage = {
    getChannelByCanonical: () => saved?.channelId === resolvedId ? saved : undefined,
    getChannel: () => saved, upsertChannel: value => { saved = { ...value }; }, addLog: entry => logs.push(entry)
  };
  const service = new exports.WorkerService(storage, { avatarsDir: 'C:\\fixture\\avatars' }, { ui: { showChannelAvatars: false } });
  service.refreshChannelAvatar = async (id, url) => {
    downloads.push({ id, url });
    if (download) Object.assign(saved, { avatarPath: `${id}.jpg`, avatarUpdatedAt: '2099-01-01T00:00:00Z' });
    return download;
  };
  return { service, downloads, logs };
}

test('adding a channel automatically caches its resolved avatar and returns the cache metadata', async () => {
  const fixture = avatarFixture();
  const channel = await fixture.service.addOrUpdateChannel({ originalUrl: 'channel-url', name: '' });
  assert.equal(fixture.downloads.length, 1);
  assert.equal(channel.avatarPath, 'new-channel.jpg');
  assert.ok(channel.avatarUpdatedAt);
});

test('an avatar download failure does not turn channel creation into a failure', async () => {
  const fixture = avatarFixture({ download: false });
  const channel = await fixture.service.addOrUpdateChannel({ originalUrl: 'channel-url', name: '' });
  assert.equal(channel.id, 'new-channel');
  assert.equal(channel.avatarPath, null);
  assert.match(fixture.logs[0].message, /头像获取暂未成功/);
});

test('editing a name keeps a valid existing avatar without downloading again', async () => {
  const fixture = avatarFixture({ existing: { id: 'existing', channelId: 'channel', avatarPath: 'existing.jpg', avatarUpdatedAt: '2099-01-01' } });
  const channel = await fixture.service.addOrUpdateChannel({ id: 'existing', originalUrl: 'channel-url', name: '新名称' });
  assert.equal(fixture.downloads.length, 0);
  assert.equal(channel.avatarPath, 'existing.jpg');
});

test('changing a channel URL never retains the previous channel portrait when download fails', async () => {
  const fixture = avatarFixture({ existing: { id: 'existing', channelId: 'previous', avatarPath: 'previous.jpg' }, resolvedId: 'different', download: false });
  const channel = await fixture.service.addOrUpdateChannel({ id: 'existing', originalUrl: 'different-url', name: '' });
  assert.equal(fixture.downloads.length, 1);
  assert.equal(channel.avatarPath, null);
});
