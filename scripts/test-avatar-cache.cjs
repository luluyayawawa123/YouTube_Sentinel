const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/worker/service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function fixture({ firstFails = false, missingInitialUrl = false } = {}) {
  const files = new Map();
  const logs = [];
  const resolved = [];
  let stored;
  let downloads = 0;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0Z8AAAAASUVORK5CYII=', 'base64');
  const mocks = {
    '@shared/constants': { CLEANUP_RANGE_OPTIONS: [] }, '@shared/utils': { makeId: () => 'fixture' },
    '@worker/storage': {}, '@worker/log-cleanup': {}, '@worker/integrations/ai': {}, '@worker/integrations/telegram': {}, '@worker/integrations/youtube-login': {},
    '@worker/integrations/ytdlp': { resolveChannelInfo: async (paths, url) => {
      resolved.push(url);
      return { channelId: 'channel', channelName: 'Fixture', canonicalUrl: 'canonical-channel', avatarUrl: missingInitialUrl && url === 'target-url' ? null : 'https://example.invalid/avatar.png' };
    }}
  };
  const exports = {};
  vm.runInNewContext(source, { exports, Error, Buffer, AbortSignal,
    fetch: async () => {
      downloads++;
      if (firstFails && downloads === 1) return { ok: false, status: 503 };
      return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from(image).buffer };
    }, require: name => {
      if (name === 'node:fs') return { existsSync: file => files.has(file), mkdirSync: () => {}, readFileSync: file => files.get(file), writeFileSync: (file, data) => files.set(file, Buffer.from(data)), rmSync: file => files.delete(file) };
      return name.startsWith('node:') ? require(name) : mocks[name];
    }
  });
  const storage = {
    getChannelByCanonical: () => undefined, getChannel: () => stored,
    upsertChannel: channel => { stored = { ...channel }; },
    updateChannelAvatar: (id, avatarPath, avatarUpdatedAt) => Object.assign(stored, { avatarPath, avatarUpdatedAt }),
    addLog: entry => logs.push(entry)
  };
  return { service: new exports.WorkerService(storage, { avatarsDir: 'C:\\fixture-virtual\\avatars' }, {}), files, logs, resolved, image, downloads: () => downloads };
}

test('actual download writes image bytes and updates avatar metadata before returning the new channel', async () => {
  const value = fixture();
  const channel = await value.service.addOrUpdateChannel({ originalUrl: 'target-url', name: '' });
  assert.equal(channel.avatarPath, 'fixture.png');
  const response = await value.service.getAvatarFile(channel.id);
  assert.equal(response.contentType, 'image/png');
  assert.ok(response.buffer.equals(value.image));
  assert.equal(value.downloads(), 1);
});

test('a failed initial download is automatically filled on image requests, with concurrent requests sharing one download', async () => {
  const value = fixture({ firstFails: true });
  const channel = await value.service.addOrUpdateChannel({ originalUrl: 'target-url', name: '' });
  assert.equal(channel.avatarPath, null);
  assert.ok(value.logs.some(item => item.message.includes('HTTP 503')));
  const responses = await Promise.all([value.service.getAvatarFile(channel.id), value.service.getAvatarFile(channel.id), value.service.getAvatarFile(channel.id)]);
  assert.ok(responses.every(response => response.buffer.equals(value.image)));
  assert.equal(value.downloads(), 2);
});

test('a target lacking an avatar resolves its channel and missing cached files are automatically restored', async () => {
  const value = fixture({ missingInitialUrl: true });
  const channel = await value.service.addOrUpdateChannel({ originalUrl: 'target-url', name: '' });
  assert.equal(channel.avatarPath, 'fixture.png');
  assert.ok(value.resolved.includes('canonical-channel'));
  value.files.clear();
  const response = await value.service.getAvatarFile(channel.id);
  assert.ok(response.buffer.equals(value.image));
  assert.equal(value.downloads(), 2);
});
