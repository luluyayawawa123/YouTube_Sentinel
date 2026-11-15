const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/worker/service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

test('diagnostics launch independent checks in parallel and report completed items before login finishes', async () => {
  const requests = [];
  const binaries = [];
  const events = [];
  let finishLogin;
  const gate = new Promise(resolve => { finishLogin = resolve; });
  const login = { cookies: 'normal', login: 'unknown', checkedAt: new Date().toISOString(), detail: 'fixture' };
  const loginRows = result => [
    { name: 'YouTube 登录状态', status: result.login === 'logged_in' ? 'ok' : 'unknown', detail: 'fixture', checkedAt: result.checkedAt, durationMs: 0 },
    { name: 'Firefox Cookies 读取', status: 'ok', detail: 'fixture', checkedAt: result.checkedAt, durationMs: 0 }
  ];
  const execFile = () => {};
  execFile[util.promisify.custom] = async () => ({ stdout: '', stderr: '' });
  const mocks = {
    '@shared/constants': { CLEANUP_RANGE_OPTIONS: [] }, '@shared/utils': {}, '@worker/storage': {},
    '@worker/log-cleanup': {}, '@worker/integrations/ai': {}, '@worker/integrations/telegram': {},
    '@worker/integrations/ytdlp': { diagnoseYtDlp: async (paths, progress) => Promise.all(['yt-dlp', 'Deno 运行时'].map(async name => {
      binaries.push(name);
      const item = { name, status: 'ok', detail: 'fixture', checkedAt: new Date().toISOString(), durationMs: 1 };
      progress(item);
      return item;
    })) },
    '@worker/integrations/youtube-login': {
      LOGIN_DIAGNOSTIC_NAMES: ['YouTube 登录状态', 'Firefox Cookies 读取'], youtubeLoginDiagnostics: loginRows,
      checkYoutubeLogin: async (paths, cookiesReady) => { cookiesReady(login); await gate; return { ...login, login: 'logged_in' }; }
    }
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, Error, AbortController, setTimeout, clearTimeout,
    fetch: async url => { requests.push(url); return { ok: true, status: 200, text: async () => 'fixture network response' }; },
    require: name => name === 'node:child_process' ? { execFile } : name.startsWith('node:') ? require(name) : mocks[name]
  });
  let saved;
  const service = new exports.WorkerService({ saveDiagnostics: result => { saved = result; } }, { rootDir: '.' }, {});
  const pending = service.runDiagnostics(item => events.push(item));
  assert.equal(requests.length, 4);
  assert.equal(binaries.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(item => item.name === 'Firefox Cookies 读取'));
  assert.ok(events.some(item => item.name === 'Google 连通性'));
  assert.ok(!events.some(item => item.name === 'YouTube 登录状态'));
  assert.equal(saved, undefined);
  finishLogin();
  const result = await pending;
  assert.equal(result.items.length, 8);
  assert.ok(events.some(item => item.name === 'YouTube 登录状态' && item.status === 'ok'));
  assert.equal(saved.items.length, 8);
});
