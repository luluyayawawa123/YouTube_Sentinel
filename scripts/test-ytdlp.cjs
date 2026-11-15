const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const ts = require('typescript');

const paths = { rootDir: 'C:\\测试 软件', binDir: 'C:\\测试 软件\\bin', configDir: 'C:\\测试 软件\\config', dataDir: 'C:\\测试 软件\\data' };
const binary = path.join(paths.binDir, 'yt-dlp.exe');
const deno = path.join(paths.binDir, 'deno.exe');
const firefoxRoot = 'C:\\Users\\测试 用户\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles';
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/worker/integrations/ytdlp.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup(files, handler = async () => ({ stdout: '{"title":"Example"}' }), firefoxSource = null) {
  const calls = [];
  const execFile = () => {};
  execFile[util.promisify.custom] = async (...args) => {
    calls.push(args);
    return handler(...args);
  };
  const exports = {};
  const mocks = {
    'node:fs': { existsSync: (file) => files.includes(file) },
    'node:path': path,
    'node:child_process': { execFile },
    'node:util': util,
    '@shared/firefox': { getFirefoxSource: () => firefoxSource }
  };
  vm.runInNewContext(source, { exports, require: (name) => {
    assert.ok(name in mocks, `Unexpected dependency: ${name}`);
    return mocks[name];
  }});
  return { api: exports, calls };
}

test('metadata reads Firefox directly, including paths with spaces and Chinese', async () => {
  const { api, calls } = setup([binary, deno], undefined, firefoxRoot);
  const metadata = await api.getVideoMetadata(paths, 'https://www.youtube.com/watch?v=example');
  assert.equal(metadata.title, 'Example');
  assert.deepEqual(Array.from(calls[0][1]), [
    '--encoding', 'utf-8', '--js-runtimes', `deno:${deno}`, '--cookies-from-browser', `firefox:${firefoxRoot}`,
    '--skip-download', '--no-playlist', '--extractor-args', 'youtube:skip=translated_subs',
    '--print', '%(.{title,description,webpage_url,upload_date,timestamp,channel,uploader,chapters,subtitles,automatic_captions})j',
    'https://www.youtube.com/watch?v=example'
  ]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].timeout, 120000);
  assert.equal(calls[0][2].maxBuffer, 64 * 1024 * 1024);
});

test('anonymous channel checks remain usable when Firefox is absent', async () => {
  const { api, calls } = setup([binary]);
  await api.fetchLatestTargetEntries(paths, 'https://www.youtube.com/@example');
  assert.ok(!calls[0][1].includes('--cookies'));
  assert.ok(!calls[0][1].includes('--cookies-from-browser'));
  assert.ok(!calls[0][1].includes('--js-runtimes'));
});

test('missing yt-dlp produces actionable error without spawning', async () => {
  const { api, calls } = setup([]);
  await assert.rejects(api.getVideoMetadata(paths, 'url'), /缺少 bin\/yt-dlp.exe/);
  assert.equal(calls.length, 0);
});

test('bot verification asks for Firefox login, never a manual export', async () => {
  for (const hasFirefox of [false, true]) {
    const { api } = setup([binary, deno], async () => {
      throw Object.assign(new Error('Command failed'), { stderr: "ERROR: Sign in to confirm you’re not a bot." });
    }, hasFirefox ? firefoxRoot : null);
    await assert.rejects(api.getVideoMetadata(paths, 'url'), hasFirefox ? /已自动读取 Firefox 当前 Cookies/ : /打开一次软件界面/);
  }
});

test('timeouts and unrelated extraction errors stay distinguishable', async () => {
  const timeout = setup([binary, deno], async () => { throw { killed: true, message: 'Command failed' }; });
  await assert.rejects(timeout.api.getVideoMetadata(paths, 'url'), /120 秒/);
  const failure = setup([binary, deno], async () => { throw { stderr: 'WARNING: warning\nERROR: Video unavailable' }; });
  await assert.rejects(failure.api.getVideoMetadata(paths, 'url'), /ERROR: Video unavailable/);
});

test('component diagnostics report executable failures without claiming login validity', async () => {
  const { api } = setup([binary, deno], async (file) => {
    if (file === deno) throw new Error('bad executable');
    return { stdout: '2026.11.01' };
  }, firefoxRoot);
  const results = await api.diagnoseYtDlp(paths);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].status, 'error');
  assert.equal(results.length, 2);
});

test('each request re-extracts Firefox cookies rather than using a cached export', async () => {
  const { api, calls } = setup([binary, deno], undefined, firefoxRoot);
  await api.getVideoMetadata(paths, 'url');
  await api.getVideoMetadata(paths, 'url');
  assert.equal(calls.length, 2);
  for (const [, args] of calls) {
    assert.ok(args.includes('--cookies-from-browser'));
    assert.ok(!args.includes('--cookies'));
  }
});

test('Firefox database access failure gives a browser instruction', async () => {
  const { api } = setup([binary, deno], async () => { throw { stderr: 'ERROR: could not find firefox cookies database' }; }, firefoxRoot);
  await assert.rejects(api.getVideoMetadata(paths, 'url'), /无需导出文件/);
});

const firefoxSourceCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/shared/firefox.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function firefoxSetup({ saved, existing = [], appData, ini = '', directories = [] } = {}) {
  const writes = [];
  const exports = {};
  vm.runInNewContext(firefoxSourceCode, {
    exports, process: { env: { APPDATA: appData } },
    require: (name) => {
      if (name === 'node:path') return path;
      assert.equal(name, 'node:fs');
      return {
        existsSync: (file) => existing.includes(file),
        readFileSync: (file) => { if (file.endsWith('profiles.ini')) return ini; if (!saved) throw new Error('missing'); return saved; },
        readdirSync: () => directories.map((name) => ({ name, isDirectory: () => true })),
        mkdirSync: () => {},
        writeFileSync: (file, data) => { saved = data; writes.push({ file, data }); }
      };
    }
  });
  return { api: exports, writes };
}

test('SYSTEM worker uses recorded interactive user profile, accepts PowerShell UTF-8 BOM', () => {
  const { api } = firefoxSetup({
    saved: '\uFEFF' + JSON.stringify({ profilesRoot: firefoxRoot }), existing: [firefoxRoot],
    appData: 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming'
  });
  assert.equal(api.getFirefoxSource(paths.configDir), firefoxRoot);
});

test('invalid or missing record never selects a SYSTEM browser profile', () => {
  for (const saved of [undefined, 'bad json', '{"profilesRoot":"relative"}']) {
    const { api } = firefoxSetup({ saved, appData: 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming' });
    assert.equal(api.getFirefoxSource(paths.configDir), null);
  }
});

test('a user worker can discover its Firefox before the UI has run', () => {
  const appData = path.dirname(path.dirname(path.dirname(firefoxRoot)));
  const { api } = firefoxSetup({ appData, existing: [firefoxRoot] });
  assert.equal(api.getFirefoxSource(paths.configDir), firefoxRoot);
});

test('opening UI refreshes machine-specific path and stores no cookies', () => {
  const { api, writes } = firefoxSetup();
  const appData = path.dirname(path.dirname(path.dirname(firefoxRoot)));
  api.rememberFirefoxSource(paths.configDir, appData);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].data), { profilesRoot: firefoxRoot });
  api.rememberFirefoxSource(paths.configDir, 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming');
  assert.equal(writes.length, 1);
});

test('Firefox default and an explicit profile choice are shared with SYSTEM and survive UI startup', () => {
  const first = path.join(firefoxRoot, 'first.default-release');
  const second = path.join(firefoxRoot, 'second.work');
  const fixture = firefoxSetup({
    saved: JSON.stringify({ profilesRoot: firefoxRoot }), existing: [firefoxRoot, first, second],
    appData: 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming',
    ini: '[InstallABC]\nDefault=Profiles/first.default-release\n[Profile0]\nName=个人\nPath=Profiles/first.default-release\nIsRelative=1\n[Profile1]\nName=工作\nPath=Profiles/second.work\nIsRelative=1'
  });
  assert.equal(fixture.api.getFirefoxSource(paths.configDir), first);
  assert.equal(fixture.api.getFirefoxProfiles(paths.configDir).profiles.length, 2);
  fixture.api.setFirefoxProfile(paths.configDir, second);
  assert.equal(fixture.api.getFirefoxSource(paths.configDir), second);
  const appData = path.dirname(path.dirname(path.dirname(firefoxRoot)));
  fixture.api.rememberFirefoxSource(paths.configDir, appData);
  assert.equal(fixture.api.getFirefoxSource(paths.configDir), second);
});

test('ambiguous profiles require selection instead of guessing from modification times', () => {
  const fixture = firefoxSetup({
    saved: JSON.stringify({ profilesRoot: firefoxRoot }),
    existing: [firefoxRoot, path.join(firefoxRoot, 'a', 'cookies.sqlite'), path.join(firefoxRoot, 'b', 'cookies.sqlite')],
    directories: ['a', 'b']
  });
  assert.equal(fixture.api.getFirefoxSource(paths.configDir), null);
  assert.throws(() => fixture.api.setFirefoxProfile(paths.configDir, 'C:\\OtherUser\\profile'), /不存在/);
});

test('a missing pinned profile is not silently replaced with another profile', () => {
  const fixture = firefoxSetup({ saved: JSON.stringify({ profilesRoot: firefoxRoot, profilePath: path.join(firefoxRoot, 'deleted') }), existing: [firefoxRoot] });
  assert.equal(fixture.api.getFirefoxSource(paths.configDir), null);
});

test('process crashes preserve the exit code instead of hiding the cause', async () => {
  const { api } = setup([binary, deno], async () => { throw { code: -1073741515, message: 'Failed to start native process' }; });
  await assert.rejects(api.getVideoMetadata(paths, 'url'), /0xC0000135.*Failed to start native process/);
});

test('yt-dlp output without ERROR prefix stays visible and proxy passwords are redacted', async () => {
  const { api } = setup([binary, deno], async () => { throw { code: 1, stderr: '[PYI] native initialization failed: https://name:password@example.com/' }; });
  await assert.rejects(api.getVideoMetadata(paths, 'url'), (error) => error.message.includes('native initialization failed') && !error.message.includes('password'));
});

const loginCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/worker/integrations/youtube-login.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function loginSetup({ rows = [{ name: 'SID', value: 'secret-test-value', expiry: 0 }], verifyError = null, networkError = false, databaseError = false } = {}) {
  let saved;
  let source = firefoxRoot;
  const requests = [];
  const exports = {};
  const DatabaseSync = class {
    constructor(file, options) { assert.equal(options.readOnly, true); if (databaseError) throw new Error('locked'); }
    exec() {}
    prepare(sql) { assert.ok(sql.includes("host IN ('.youtube.com'")); return { all: () => rows }; }
    close() {}
  };
  vm.runInNewContext(loginCode, { exports, AbortSignal,
    module: { require: (name) => { assert.equal(name, 'node:sqlite'); return { DatabaseSync }; } },
    require: (name) => {
    if (name === 'node:path') return path;
    if (name === '@shared/firefox') return { getFirefoxSource: () => source };
    if (name === '@worker/integrations/ytdlp') return { verifyYoutubeLogin: async (inputPaths) => {
      requests.push(inputPaths);
      if (networkError) throw new Error('connection failed');
      if (verifyError) throw new Error(verifyError);
    }};
    assert.equal(name, 'node:fs');
    return {
      readFileSync: () => { if (!saved) throw new Error('missing'); return saved; },
      writeFileSync: (file, data) => { saved = data; },
      readdirSync: () => [{ name: 'cookies.sqlite', isFile: () => true, isDirectory: () => false }],
      statSync: () => ({ mtimeMs: 1 })
    };
  }});
  return { api: exports, requests, saved: () => saved, changeSource: () => { source = null; }, corrupt: () => { saved = 'null'; } };
}

test('login requires YouTube confirmation, while cookie values are never persisted', async () => {
  const fixture = loginSetup();
  const status = await fixture.api.checkYoutubeLogin(paths);
  assert.equal(status.cookies, 'normal');
  assert.equal(status.login, 'logged_in');
  assert.ok(status.checkedAt);
  assert.equal(fixture.api.getYoutubeLoginStatus(paths).login, 'logged_in');
  assert.ok(!fixture.saved().includes('secret-test-value'));
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].configDir, paths.configDir);
});

test('changed browser source and corrupt records do not inherit old login status', async () => {
  const { api, changeSource, corrupt } = loginSetup();
  await api.checkYoutubeLogin(paths);
  changeSource();
  assert.equal(api.getYoutubeLoginStatus(paths).login, 'unknown');
  corrupt();
  assert.equal(api.getYoutubeLoginStatus(paths).login, 'unknown');
});

test('readable cookies are not confused with signed-in state', async () => {
  const { api } = loginSetup({ verifyError: 'Login details are needed to download this content' });
  const result = await api.checkYoutubeLogin(paths);
  assert.equal(result.cookies, 'normal');
  assert.equal(result.login, 'not_logged_in');
});

test('network errors never report a logout and database errors never report readable cookies', async () => {
  const network = await loginSetup({ networkError: true }).api.checkYoutubeLogin(paths);
  assert.equal(network.cookies, 'normal');
  assert.equal(network.login, 'unknown');
  const database = await loginSetup({ databaseError: true }).api.checkYoutubeLogin(paths);
  assert.equal(database.cookies, 'unavailable');
  assert.equal(database.login, 'unknown');
});

test('expired cookies and empty YouTube cookie sets do not make network requests', async () => {
  const fixture = loginSetup({ rows: [{ name: 'SID', value: 'expired', expiry: 1 }] });
  const result = await fixture.api.checkYoutubeLogin(paths);
  assert.equal(result.cookies, 'normal');
  assert.equal(result.login, 'not_logged_in');
  assert.equal(fixture.requests.length, 0);
});

test('unconfirmed engine responses are not treated as logged out; challenges require verification', async () => {
  assert.equal((await loginSetup({ verifyError: '未获得有效的订阅页响应' }).api.checkYoutubeLogin(paths)).login, 'unknown');
  assert.equal((await loginSetup({ verifyError: 'Sign in to confirm you’re not a bot' }).api.checkYoutubeLogin(paths)).login, 'verification_required');
});

test('diagnostics show login and cookie reading as separate results', async () => {
  const { api } = loginSetup({ verifyError: 'Login details are needed to download this content' });
  const result = await api.checkYoutubeLogin(paths);
  const items = api.youtubeLoginDiagnostics(result, 100);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'YouTube 登录状态');
  assert.equal(items[0].status, 'error');
  assert.match(items[0].detail, /Login details are needed/);
  assert.equal(items[1].name, 'Firefox Cookies 读取');
  assert.equal(items[1].status, 'ok');
  assert.equal(items[0].checkedAt, result.checkedAt);
  assert.equal(items[0].durationMs, 100);
});

test('network uncertainty does not mark readable cookies as failed', async () => {
  const { api } = loginSetup({ networkError: true });
  const result = await api.checkYoutubeLogin(paths);
  const items = api.youtubeLoginDiagnostics(result);
  assert.equal(items[0].status, 'unknown');
  assert.match(items[0].detail, /无法确认/);
  assert.equal(items[1].status, 'ok');
  assert.equal(api.youtubeLoginDiagnostics({ ...result, checkedAt: null }).length, 0);
});

test('large stdout errors never expose truncated subtitle JSON to the interface', async () => {
  const { api } = setup([binary, deno], async () => {
    throw { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '{"automatic_captions":{"ti":[{"url":"https://example.invalid/long-subtitle"}]' };
  });
  await assert.rejects(api.getVideoMetadata(paths, 'url'), (error) => error.message.length < 150 && !error.message.includes('http') && error.message.includes('不是 Firefox 登录失败'));
});

test('login verification uses the authenticated subscriptions extractor with zero entries', async () => {
  const { api, calls } = setup([binary, deno], async () => ({ stdout: '{"_type":"playlist","id":"FEsubscriptions","entries":[]}' }), firefoxRoot);
  await api.verifyYoutubeLogin(paths);
  assert.ok(calls[0][1].includes(':ytsubs'));
  assert.equal(calls[0][1][calls[0][1].indexOf('--playlist-items') + 1], '0');
  assert.ok(calls[0][1].includes(`firefox:${firefoxRoot}`));
  const unrelated = setup([binary], async () => ({ stdout: '{"_type":"playlist","id":"public-channel"}' }));
  await assert.rejects(unrelated.api.verifyYoutubeLogin(paths), /无法确认登录状态/);
});

test('real yt-dlp reduces a metadata fixture exceeding 10 MB to required fields without downloading', async () => {
  const { tmpdir } = require('node:os');
  const { execFile } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'sentinel-metadata-fixture-'));
  const filename = path.join(directory, 'fixture.info.json');
  const fixture = {
    id: 'fixture', title: 'Fixture title', description: 'Fixture description', ext: 'mp4',
    webpage_url: 'https://example.invalid/watch', channel: 'Fixture channel',
    formats: [{ format_id: 'fixture', ext: 'mp4', url: 'https://example.invalid/video.mp4', format_note: 'x'.repeat(12 * 1024 * 1024) }],
    subtitles: { en: [{ ext: 'vtt', url: 'https://example.invalid/sub.vtt' }] },
    automatic_captions: { es: [{ ext: 'json3', url: 'https://example.invalid/sub.json3' }] }
  };
  fs.writeFileSync(filename, JSON.stringify(fixture));
  try {
    assert.ok(fs.statSync(filename).size > 10 * 1024 * 1024);
    const result = await util.promisify(execFile)(path.join(__dirname, '../bin/yt-dlp.exe'), [
      '--ignore-config', '--load-info-json', filename, '--skip-download', '--no-playlist',
      '--extractor-args', 'youtube:skip=translated_subs',
      '--print', '%(.{title,description,webpage_url,upload_date,timestamp,channel,uploader,chapters,subtitles,automatic_captions})j'
    ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 });
    const output = JSON.parse(result.stdout);
    assert.equal(output.title, fixture.title);
    assert.equal(output.subtitles.en[0].url, fixture.subtitles.en[0].url);
    assert.equal(output.automatic_captions.es[0].ext, 'json3');
    assert.equal(output.formats, undefined);
    assert.ok(Buffer.byteLength(result.stdout) < 10000);
  } finally {
    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  }
});
