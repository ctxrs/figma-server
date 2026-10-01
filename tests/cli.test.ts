import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli, type CliOptions } from '../src/cli.js';
import { Core } from '../src/core.js';
import { Fault } from '../src/errors.js';
import { serve } from '../src/main.js';
import { DAEMON_URL, stdioProxy } from '../src/proxy.js';
import { LIMITS } from '../src/security.js';
import { Metadata, State } from '../src/state.js';
import { FakeBrowser, PNG } from './helpers.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function paddedPng(size: number): Buffer {
  const chunk = Buffer.alloc(size - PNG.length, 97);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write('tEXt', 4);
  chunk.write('note\0', 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}
function capture(): { stream: Writable; text: () => string } {
  let value = '';
  return { stream: new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } }), text: () => value };
}
async function isolated(t: { after: (fn: () => Promise<void>) => void }): Promise<State> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new State(root);
}
async function initialized(t: { after: (fn: () => Promise<void>) => void }): Promise<State> {
  const state = await isolated(t);
  await state.init({ version: 1, browser: process.execPath, accounts: [{ name: 'default', loginOrigins: [] }] });
  return state;
}
function invocation(state: State, extra: CliOptions = {}) {
  const out = capture(), err = capture();
  return { out, err, cli: (args: string[]) => runCli(args, { state, stdout: out.stream, stderr: err.stream, ...extra }) };
}

test('init is idempotent, private and repairs interrupted token creation without changing settings', async t => {
  const state = await isolated(t);
  const { cli, out, err } = invocation(state);
  assert.equal(await cli(['init', '--browser', process.execPath, '--probe-url', 'https://www.figma.com/design/abcdef123']), 0);
  const config = await readFile(state.path('config.json'), 'utf8');
  const secret = await state.secret();
  assert.equal(await cli(['init']), 0);
  assert.equal(await readFile(state.path('config.json'), 'utf8'), config);
  assert.equal(await state.secret(), secret);
  assert.match(out.text(), /Already initialized/);
  assert.equal(err.text(), '');
  assert.ok(!out.text().includes(secret));
  if (process.platform !== 'win32') {
    assert.equal((await lstat(state.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(state.path('secret'))).mode & 0o777, 0o600);
  }
  assert.equal(await cli(['init', '--probe-url', 'https://www.figma.com/design/changed123']), 1);
  assert.equal(await readFile(state.path('config.json'), 'utf8'), config);
  await rm(state.path('secret'));
  assert.equal(await cli(['init']), 0);
  assert.match(await state.secret(), /^[a-f0-9]{64}$/);
  assert.equal(await readFile(state.path('config.json'), 'utf8'), config);
});

test('CLI rejects arbitrary roots, listener overrides, unknown options and invalid browser/URL inputs', async t => {
  const state = await isolated(t);
  for (const args of [
    ['run', '--host', '0.0.0.0'], ['init', '--data-dir', '/tmp/other'], ['mcp', '--token', 'do-not-echo-me'],
    ['init', '--browser', 'chromium;touch /tmp/never'], ['init', '--probe-url', 'http://127.0.0.1/private'], ['login', '--account', '../../profile'],
  ]) {
    const { cli, err, out } = invocation(state);
    assert.equal(await cli(args), 1);
    assert.ok(err.text().length > 0);
    assert.ok(!err.text().includes('do-not-echo-me'));
    assert.equal(out.text(), '');
  }
});

test('init accepts a system browser symlink and stores the canonical executable path', { skip: process.platform === 'win32' }, async t => {
  const state = await isolated(t);
  const entry = state.path('system-chrome');
  await symlink(process.execPath, entry);
  const { cli, err } = invocation(state);
  assert.equal(await cli(['init', '--browser', entry]), 0);
  assert.equal((await state.config()).browser, await realpath(process.execPath));
  assert.equal(await cli(['init', '--browser', entry]), 0);
  assert.equal(err.text(), '');
});

test('init --browser updates existing settings atomically under the profile lock, preserving accounts, token and profiles', async t => {
  const state = await isolated(t);
  const config = { version: 1 as const, accounts: [
    { name: 'default', loginOrigins: ['https://login.example.com'], probeUrl: 'https://www.figma.com/design/abcdef123' },
    { name: 'other', loginOrigins: [] },
  ] };
  await state.init(config);
  const secret = await state.secret();
  const original = await readFile(state.path('config.json'), 'utf8');
  const inode = (await lstat(state.path('config.json'))).ino;
  const profile = state.path('accounts', 'default', 'profile', 'keep');
  await writeFile(profile, 'existing profile', { mode: 0o600 });
  const { cli, out, err } = invocation(state);
  const unlock = await state.lock();
  try {
    assert.equal(await cli(['init', '--browser', process.execPath]), 1);
    assert.match(err.text(), /Another daemon or login/);
    assert.equal(await readFile(state.path('config.json'), 'utf8'), original);
  } finally { await unlock(); }
  assert.equal(await cli(['init', '--browser', process.execPath]), 0);
  assert.deepEqual(await state.config(), { ...config, browser: await realpath(process.execPath) });
  assert.equal(await state.secret(), secret);
  assert.equal(await readFile(profile, 'utf8'), 'existing profile');
  assert.match(out.text(), /Updated browser/);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(state.path('config.json'))).mode & 0o777, 0o600);
    assert.notEqual((await lstat(state.path('config.json'))).ino, inode);
  }
  assert.ok(!(await readdir(state.root)).some(name => name.endsWith('.tmp')));
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
});

test('unsafe state permissions fail closed with no token printed', { skip: process.platform === 'win32' }, async t => {
  const state = await initialized(t);
  const secret = await state.secret();
  await chmod(state.path('secret'), 0o644);
  const { cli, out, err } = invocation(state);
  assert.equal(await cli(['doctor']), 1);
  assert.match(err.text(), /0600/);
  assert.ok(!out.text().includes(secret) && !err.text().includes(secret));
});

test('browser-install uses the local pinned Playwright CLI with full Chromium, no shell and no stdout logs', async t => {
  const state = await isolated(t);
  const child = new PassThrough() as unknown as ChildProcess;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
  const spawn = t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, process.execPath);
    assert.ok(args[0]?.endsWith(join('playwright', 'cli.js')));
    assert.deepEqual(args.slice(1), ['install', 'chromium', '--no-shell']);
    assert.equal(options.shell, false);
    process.nextTick(() => { child.stdout!.emit('data', 'installed\n'); child.emit('close', 0); });
    return child;
  });
  const { cli, out, err } = invocation(state);
  assert.equal(await cli(['browser-install']), 0);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(out.text(), '');
  assert.match(err.text(), /installed/);
  spawn.mock.restore();
});

test('offline login requires a human terminal and holds the exclusive profile lock until browser teardown', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  const noninteractive = invocation(state, { stdin: new PassThrough(), browser: () => browser });
  assert.equal(await noninteractive.cli(['login']), 1);
  assert.match(noninteractive.err.text(), /human terminal/);
  let confirmed = false, stopped = false;
  browser.stop = async () => {
    await lstat(state.path('daemon.lock'));
    stopped = true;
  };
  const { cli, out, err } = invocation(state, { browser: () => browser, confirm: async () => {
    confirmed = true;
    await assert.rejects(state.lock(), { code: 'daemon_locked' });
  } });
  assert.equal(await cli(['login']), 0);
  assert.ok(confirmed && stopped);
  assert.equal(out.text(), '');
  assert.match(err.text(), /Login profile saved/);
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
});

test('run, status, doctor and daemon-assisted login share authenticated core and clean up on shutdown', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  const controller = new AbortController();
  const output = new PassThrough();
  let logs = '';
  output.on('data', chunk => { logs += chunk.toString(); });
  const ready = new Promise<void>(done => output.on('data', () => { if (logs.includes('Figma daemon ready')) done(); }));
  const running = runCli(['run'], { state, browser: () => browser, signal: controller.signal, stderr: output });
  t.after(async () => { controller.abort(); await running; });
  await ready;
  const status = invocation(state);
  assert.equal(await status.cli(['status']), 0);
  assert.match(status.out.text(), /default: ready/);
  assert.equal(await status.cli(['doctor']), 0);
  assert.match(status.out.text(), /Daemon: connected/);
  browser.states.set('default', { account: 'default', state: 'permission_denied', generation: browser.generation });
  assert.equal(await status.cli(['status']), 0);
  assert.match(status.out.text(), /Check file sharing permissions/);
  browser.states.set('default', { account: 'default', state: 'ready', generation: browser.generation });
  let confirms = 0;
  const login = invocation(state, { confirm: async () => { confirms++; }, browser: () => { throw new Error('must use daemon'); } });
  assert.equal(await login.cli(['login']), 0);
  assert.equal(confirms, 1);
  assert.match(login.err.text(), /Daemon opened exclusive login/);
  assert.doesNotMatch(login.err.text(), /interrupted|cleanup/);
  const unauthorized = await initialized(t);
  const denied = invocation(unauthorized, { confirm: async () => {}, browser: () => { throw new Error('must not fall back'); } });
  assert.equal(await denied.cli(['login']), 1);
  assert.match(denied.err.text(), /authentication failed/);
  assert.equal((await fetch(`${DAEMON_URL}/api/status`)).status, 401);
  assert.equal((await fetch(`${DAEMON_URL}/json/version`, { headers: { Authorization: `Bearer ${await state.secret()}` } })).status, 404);
  controller.abort();
  assert.equal(await running, 0);
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
  assert.ok(!logs.includes(await state.secret()));
  assert.match(logs, /Stopping Figma daemon/);
  const stopped = invocation(state);
  assert.equal(await stopped.cli(['doctor']), 1);
  assert.match(stopped.out.text(), /Next: figma-server run/);
});

test('startup failures close browsers and metadata before releasing the lock', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  let stopped = false;
  browser.start = async () => { throw new Fault('browser_start_failed', 'Chromium could not start.'); };
  browser.stop = async () => { stopped = true; await lstat(state.path('daemon.lock')); };
  const { cli, err } = invocation(state, { browser: () => browser });
  assert.equal(await cli(['run']), 1);
  assert.ok(stopped);
  assert.match(err.text(), /sandbox enabled/);
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
});

test('interrupted offline login tears down the browser; failed teardown retains the profile lock', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  const controller = new AbortController();
  let stopped = false;
  browser.stop = async () => { stopped = true; };
  const cancelled = invocation(state, { browser: () => browser, signal: controller.signal, confirm: async () => { controller.abort(); } });
  assert.equal(await cancelled.cli(['login']), 0);
  assert.ok(stopped);
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
  browser.stop = async () => { throw new Error('cannot confirm shutdown'); };
  const failed = invocation(state, { browser: () => browser, confirm: async () => {} });
  assert.equal(await failed.cli(['login']), 1);
  await lstat(state.path('daemon.lock'));
  await assert.rejects(state.lock(), { code: 'daemon_locked' });
});

for (const mode of ['deadline', 'human', 'http-fault', 'signal'] as const) {
  test(`interactive login exits naturally with stdin open after ${mode}`, { skip: mode === 'signal' && process.platform === 'win32' }, async t => {
    const home = await isolated(t);
    const cliUrl = pathToFileURL(cliPath).href;
    const source = `
      import { BrowserSupervisor } from ${JSON.stringify(new URL('./browser-supervisor.js', cliUrl).href)};
      import { State, defaultRoot } from ${JSON.stringify(new URL('./state.js', cliUrl).href)};
      import { Fault } from ${JSON.stringify(new URL('./errors.js', cliUrl).href)};
      const mode = ${JSON.stringify(mode)};
      const state = new State(defaultRoot());
      await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }] });
      const token = await state.secret();
      globalThis.fetch = async (url, init) => {
        if (mode !== 'http-fault') {
          const error = new Error('fixture offline');
          error.cause = { code: 'ECONNREFUSED' };
          throw error;
        }
        if (new Headers(init.headers).get('Authorization') !== 'Bearer ' + token) throw new Error('missing authentication');
        const path = new URL(url).pathname;
        const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        if (path === '/api/status') return json({ accounts: [{ account: 'default', state: 'ready' }] });
        if (path === '/api/login/start') return json({ login: '00000000-0000-4000-8000-000000000001' }, 202);
        if (path === '/api/login/confirm') return json({ error: { code: 'login_timeout' } }, 409);
        if (path === '/api/login/cancel') {
          process.stderr.write('CANCEL_AWAITED\\n');
          return json({ cancelled: true, account: 'default', status: { account: 'default', state: 'stopped' } });
        }
        throw new Error('unexpected endpoint');
      };
      BrowserSupervisor.prototype.login = async function(account, confirm) {
        let timer;
        try {
          return await Promise.race([
            confirm().then(() => {
              process.stderr.write('HUMAN_CONFIRMED\\n');
              return { account, state: 'authenticated_unverified' };
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Fault('login_timeout', 'Login deadline expired.')), mode === 'deadline' ? 40 : 5000);
            }),
          ]);
        } finally { clearTimeout(timer); }
      };
      BrowserSupervisor.prototype.stop = async function() { process.stderr.write('BROWSER_STOPPED\\n'); };
      // A real child stdin pipe stays open. Only the TTY gate is injected so
      // this uses the actual readline question, not an options.confirm stub.
      process.stdin.isTTY = true;
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, 'login'];
      await import(${JSON.stringify(cliUrl)});
      process.stderr.write('CLI_RETURNED ' + JSON.stringify({ code: process.exitCode, paused: process.stdin.isPaused(), dataListeners: process.stdin.listenerCount('data') }) + '\\n');
    `;
    const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, HOME: home.root, USERPROFILE: home.root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });
    let stdout = '', stderr = '', action: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (mode !== 'deadline' && !action && stderr.includes('then press Enter here:')) {
        action = setTimeout(() => {
          if (mode === 'signal') child.kill('SIGINT');
          else child.stdin.write('\n');
        }, 100);
      }
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    t.after(() => { if (action) clearTimeout(action); if (timeout) clearTimeout(timeout); });
    const exit = await Promise.race([
      closed,
      new Promise<null>(done => { timeout = setTimeout(() => done(null), 2500); }),
    ]);
    assert.ok(exit, `CLI did not exit naturally with stdin left open: ${stderr}`);
    assert.equal(exit[0], mode === 'deadline' || mode === 'http-fault' ? 1 : 0, stderr);
    assert.equal(exit[1], null, 'successful regression must not rely on a kill signal');
    assert.equal(child.stdin.writableEnded, false, 'test must not send stdin EOF to make the CLI exit');
    assert.equal(stdout, '');
    const returned = /CLI_RETURNED (\{[^\n]+\})/.exec(stderr);
    assert.ok(returned?.[1], stderr);
    assert.deepEqual(JSON.parse(returned[1]), { code: exit[0], paused: true, dataListeners: 0 });
    if (mode === 'deadline') {
      assert.match(stderr, /Login deadline expired/);
      assert.doesNotMatch(stderr, /HUMAN_CONFIRMED|profile saved/);
    }
    if (mode === 'human') assert.match(stderr, /HUMAN_CONFIRMED/);
    if (mode === 'http-fault') { assert.match(stderr, /CANCEL_AWAITED/); assert.match(stderr, /login_timeout/); }
    else assert.match(stderr, /BROWSER_STOPPED/);
    const root = process.platform === 'win32' ? join(home.root, 'AppData', 'Local', 'figma-server')
      : process.platform === 'darwin' ? join(home.root, 'Library', 'Application Support', 'figma-server') : join(home.root, '.figma-server');
    await assert.rejects(lstat(join(root, 'daemon.lock')), { code: 'ENOENT' });
    const unlock = await new State(root).lock();
    await unlock();
  });
}

for (const expiration of ['backend', 'server'] as const) {
test(`daemon ${expiration} deadline exits without Enter or an RPC callback with stdin open`, async t => {
  const home = await isolated(t);
  const root = process.platform === 'win32' ? join(home.root, 'AppData', 'Local', 'figma-server')
    : process.platform === 'darwin' ? join(home.root, 'Library', 'Application Support', 'figma-server') : join(home.root, '.figma-server');
  const state = new State(root);
  await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }] });
  const browser = new FakeBrowser(['default']);
  let expired = false, drained = false;
  if (expiration === 'server') {
    const realTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === LIMITS.loginMs) return realTimeout(() => { expired = true; callback(...args); }, 40);
      return realTimeout(callback, delay, ...args);
    });
  }
  browser.login = async (account, confirm) => {
    browser.states.set(account, { account, state: 'authorizing' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const confirmed = confirm().then(() => browser.status(account));
      if (expiration === 'server') return await confirmed;
      return await Promise.race([
        confirmed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Fault('login_timeout', 'Backend login expired.', 409)); }, 40);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await new Promise(done => setTimeout(done, 200));
      browser.states.set(account, { account, state: 'stopped' });
      drained = true;
    }
  };
  const core = new Core(browser, state, await Metadata.open(state));
  const daemon = await serve(core, { token: await state.secret(), accounts: ['default'] });
  t.after(async () => { await daemon.close(); await core.stop(); });
  const source = `
    import { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};
    const realFetch = globalThis.fetch;
    let confirms = 0, cancels = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/api/login/confirm')) confirms++;
      if (String(url).endsWith('/api/login/cancel')) {
        if (init.signal.aborted) throw new Error('cleanup signal was aborted');
        cancels++;
      }
      return realFetch(url, init);
    };
    process.stdin.isTTY = true;
    process.exitCode = await runCli(['login'], { confirmationMs: ${expiration === 'server' ? 300 : 150} });
    process.stderr.write('CLI_RETURNED ' + JSON.stringify({ code: process.exitCode, confirms, cancels,
      paused: process.stdin.isPaused(), dataListeners: process.stdin.listenerCount('data') }) + '\\n');
  `;
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, HOME: home.root, USERPROFILE: home.root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([closed, new Promise<null>(done => { timer = setTimeout(() => done(null), 2500); })]);
  clearTimeout(timer);
  assert.ok(exit, `CLI waited for Enter after the server deadline: ${stderr}`);
  assert.deepEqual(exit, [1, null], stderr);
  assert.equal(child.stdin.writableEnded, false, 'stdin remains open and no Enter was sent');
  assert.equal(stdout, '');
  assert.ok(expired && drained, 'cancel must await the independently expired backend draining');
  assert.equal(browser.status('default').state, 'stopped');
  assert.match(stderr, /Login timed out.*figma-server login/);
  assert.match(stderr, expiration === 'server' ? /cleanup could not be confirmed/ : /daemon login cleanup completed/);
  assert.doesNotMatch(stderr, /profile saved/);
  assert.ok(!stderr.includes(await state.secret()));
  const returned = /CLI_RETURNED (\{[^\n]+\})/.exec(stderr);
  assert.ok(returned?.[1], stderr);
  assert.deepEqual(JSON.parse(returned[1]), { code: 1, confirms: 0, cancels: 1, paused: true, dataListeners: 0 });
  await assert.rejects(lstat(state.path('daemon.lock')), { code: 'ENOENT' });
});
}

test('interrupted daemon login uses an independent authenticated cancel request and awaits browser cleanup', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  let cleanupStarted!: () => void, releaseCleanup!: () => void;
  const cleaning = new Promise<void>(done => { cleanupStarted = done; });
  const cleaned = new Promise<void>(done => { releaseCleanup = done; });
  browser.login = async (account, confirm) => {
    browser.states.set(account, { account, state: 'authorizing' });
    try { await confirm(); return browser.status(account); }
    finally {
      cleanupStarted();
      await cleaned;
      browser.states.set(account, { account, state: 'stopped' });
    }
  };
  const core = new Core(browser, state, await Metadata.open(state));
  const daemon = await serve(core, { token: await state.secret(), accounts: ['default'] });
  t.after(async () => { releaseCleanup(); await daemon.close(); await core.stop(); });
  const controller = new AbortController();
  const { cli, out, err } = invocation(state, { signal: controller.signal, confirm: async () => { controller.abort(); } });
  let settled = false;
  const pending = cli(['login']).then(code => { settled = true; return code; });
  await cleaning;
  assert.equal(settled, false, 'CLI must await the daemon closing the login browser');
  releaseCleanup();
  assert.equal(await pending, 0);
  assert.equal(browser.status('default').state, 'stopped');
  assert.match(err.text(), /daemon login cleanup completed/);
  assert.doesNotMatch(err.text(), /default:|profile saved|could not be confirmed/);
  assert.equal(out.text(), '');
  assert.ok(!err.text().includes(await state.secret()));
  // The daemon no longer holds a login slot, so another human can retry.
  const retry = invocation(state, { confirm: async () => {} });
  assert.equal(await retry.cli(['login']), 0);
});

test('unconfirmed cancellation reports recovery and preserves the original login failure', async t => {
  const state = await initialized(t);
  const browser = new FakeBrowser(['default']);
  const core = new Core(browser, state, await Metadata.open(state));
  const daemon = await serve(core, { token: await state.secret(), accounts: ['default'] });
  t.after(async () => { await daemon.close(); await core.stop(); });
  const originalFetch = globalThis.fetch.bind(globalThis);
  let unsafeStatus = false;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/login/cancel')) {
      assert.equal(init?.signal?.aborted, false);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${await state.secret()}`);
      const response = await originalFetch(url, init);
      await response.body?.cancel();
      return new Response(JSON.stringify({ cancelled: unsafeStatus, account: 'default', status: { account: 'default', state: 'authorizing' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, init);
  });
  for (const status of [false, true]) {
    unsafeStatus = status;
    const { cli, err } = invocation(state, { confirm: async () => { throw new Fault('confirmation_failed', 'Human ended login.'); } });
    assert.equal(await cli(['login']), 1);
    assert.match(err.text(), /Human ended login/);
    assert.match(err.text(), /cleanup could not be confirmed.*Stop the daemon/);
    assert.doesNotMatch(err.text(), /cleanup completed|default:|profile saved/);
  }
  fetchMock.mock.restore();
});

// A real SDK client parses every byte of proxy stdout. Any banner breaks connect.
test('SDK stdio client negotiates HTTP, calls tools/images, and releases session/leases on client exit', async t => {
  const home = await isolated(t);
  const childEnv = { ...process.env, HOME: home.root, USERPROFILE: home.root };
  const entry = process.platform === 'win32' ? cliPath : join(home.root, 'figma server');
  if (entry !== cliPath) await symlink(cliPath, entry);
  const init = childProcess.spawn(process.execPath, [entry, 'init'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const errors: Buffer[] = [];
  init.stderr.on('data', chunk => errors.push(chunk));
  assert.equal((await once(init, 'close'))[0], 0, Buffer.concat(errors).toString());
  // Mirror the documented native OS root, without adding a production override.
  const root = process.platform === 'win32' ? join(home.root, 'AppData', 'Local', 'figma-server')
    : process.platform === 'darwin' ? join(home.root, 'Library', 'Application Support', 'figma-server') : join(home.root, '.figma-server');
  const state = new State(root);
  const browser = new FakeBrowser(['default']);
  const core = new Core(browser, state, await Metadata.open(state));
  const daemon = await serve(core, { token: await state.secret(), accounts: ['default'] });
  t.after(async () => { await daemon.close(); await core.stop(); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: childEnv, stderr: 'pipe',
    maxBufferSize: LIMITS.uploadBodyBytes + 64 * 1024 });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
  const client = new Client({ name: 'cli-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'figma.open'));
  const status = await client.callTool({ name: 'figma.account_status', arguments: { account: 'default' } });
  assert.ok(JSON.stringify(status).includes('ready'));
  const opened = await client.callTool({ name: 'figma.open', arguments: { account: 'default', file_url: 'https://www.figma.com/design/abcdef123', mode: 'write' } });
  const content = opened.content as { type: string; text: string }[];
  const lease = (JSON.parse(content[0]!.text) as { lease: string }).lease;
  const image = await client.callTool({ name: 'figma.screenshot', arguments: { lease } });
  assert.ok((image.content as { type: string }[]).some(item => item.type === 'image'));
  const supplied = paddedPng(LIMITS.imageBytes);
  const encoded = supplied.toString('base64');
  const trigger = { by: 'role', role: 'button', name: 'Upload image' } as const;
  let uploads = 0;
  browser.tabs[0]!.uploadImage = async (payload, locator) => {
    uploads++;
    assert.equal(payload.name, 'supplied.png');
    assert.equal(payload.mimeType, 'image/png');
    assert.ok(payload.buffer.equals(supplied), 'SDK stdio must forward the exact supplied 8 MiB image bytes');
    assert.deepEqual(locator, trigger);
  };
  const uploaded = await client.callTool({ name: 'figma.upload_image', arguments: {
    lease, filename: 'supplied.png', data_base64: encoded, trigger,
  } });
  assert.equal(uploaded.isError, false);
  assert.equal(uploads, 1);
  const screenshot = browser.tabs[0]!.screenshot;
  browser.tabs[0]!.screenshot = async () => supplied;
  try {
    const result = await client.callTool({ name: 'figma.screenshot', arguments: { lease } });
    const returned = (result.content as { type: string; data?: string }[]).find(item => item.type === 'image');
    assert.ok(returned?.data === encoded, 'stdout must preserve a valid 8 MiB image response');
  } finally { browser.tabs[0]!.screenshot = screenshot; }
  await client.callTool({ name: 'figma.click', arguments: { lease, locator: trigger, modifiers: ['Shift', 'ControlOrMeta'] } });
  assert.equal(core.sessions.sessions.size, 1);
  assert.equal(core.sessions.leases.size, 1);
  await client.close();
  assert.equal(core.sessions.sessions.size, 0);
  assert.equal(core.sessions.leases.size, 0);
  assert.ok(browser.tabs.every(tab => tab.closed));
  assert.ok(!diagnostics.includes(await state.secret()));
  // Windows process.kill(SIGTERM) forcibly terminates a child; graceful stream
  // closure above is portable, while POSIX also exercises the signal handler.
  if (process.platform === 'win32') return;
  const signalTransport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: childEnv, stderr: 'pipe' });
  const signalClient = new Client({ name: 'signal-test', version: '1' });
  t.after(() => signalClient.close());
  await signalClient.connect(signalTransport);
  await signalClient.callTool({ name: 'figma.open', arguments: { account: 'default', file_url: 'https://www.figma.com/design/abcdef123', mode: 'read' } });
  const previous = signalTransport.onclose;
  const exited = new Promise<void>(done => { signalTransport.onclose = () => { previous?.(); done(); }; });
  process.kill(signalTransport.pid!, 'SIGTERM');
  await exited;
  assert.equal(core.sessions.sessions.size, 0);
  assert.equal(core.sessions.leases.size, 0);
});

test('proxy exits on EOF/signal and rejects oversized input without leaking credentials', async t => {
  const state = await initialized(t);
  const input = new PassThrough(), output = capture(), errors = capture();
  const pending = stdioProxy(state, { stdin: input, stdout: output.stream, stderr: errors.stream });
  input.end();
  await pending;
  assert.equal(output.text(), '');
  const controller = new AbortController();
  const signalled = stdioProxy(state, { stdin: new PassThrough(), stdout: output.stream, stderr: errors.stream, signal: controller.signal });
  controller.abort();
  await signalled;
  const oversized = new PassThrough();
  const rejected = stdioProxy(state, { stdin: oversized, stdout: output.stream, stderr: errors.stream });
  oversized.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'unknown', arguments: { text: 'a'.repeat(LIMITS.bodyBytes) } } }) + '\n');
  await assert.rejects(rejected, { code: 'mcp_connection_failed' });
  assert.ok(!errors.text().includes(await state.secret()));
});

test('proxy large-frame exemption rejects ordinary calls, fake uploads and invalid images before HTTP forwarding', async t => {
  const state = await initialized(t);
  let forwarded = 0;
  t.mock.method(globalThis, 'fetch', async () => { forwarded++; throw new Error('must not forward'); });
  const data = paddedPng(160 * 1024).toString('base64');
  const arguments_ = { lease: '00000000-0000-4000-8000-000000000001', filename: 'image.png',
    data_base64: data, trigger: { by: 'role', role: 'button', name: 'Upload image' } };
  const upload = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'figma.upload_image', arguments: arguments_ } };
  const invalid = [
    { ...upload, method: 'unknown' },
    { ...upload, params: { ...upload.params, name: 'unknown' } },
    { ...upload, params: { ...upload.params, arguments: { ...arguments_, host_path: '/private/image.png' } } },
    { ...upload, params: { ...upload.params, arguments: { ...arguments_, lease: 'invalid' } } },
    { ...upload, params: { ...upload.params, arguments: { ...arguments_, filename: '../image.png' } } },
    { ...upload, params: { ...upload.params, arguments: { ...arguments_, data_base64: 'a'.repeat(data.length) } } },
    { ...upload, params: { ...upload.params, arguments: { ...arguments_, data_base64: paddedPng(LIMITS.imageBytes + 1).toString('base64') } } },
    { ...upload, id: 'a'.repeat(LIMITS.bodyBytes) },
    { ...upload, params: { ...upload.params, _meta: { padding: 'a'.repeat(LIMITS.bodyBytes) } } },
    { jsonrpc: '2.0', method: upload.method, params: upload.params },
  ];
  const hugeDimension = paddedPng(160 * 1024);
  hugeDimension.writeUInt32BE(8193, 16);
  invalid.push({ ...upload, params: { ...upload.params, arguments: { ...arguments_, data_base64: hugeDimension.toString('base64') } } });
  const frames = invalid.map(value => JSON.stringify(value) + '\n');
  // A tiny real image plus whitespace must not buy an oversized ordinary frame.
  frames.push(' '.repeat(LIMITS.bodyBytes) + JSON.stringify({ ...upload,
    params: { ...upload.params, arguments: { ...arguments_, data_base64: PNG.toString('base64') } } }) + '\n');
  for (const frame of frames) {
    const input = new PassThrough(), out = capture(), err = capture();
    const ready = once(input, 'resume');
    const pending = stdioProxy(state, { stdin: input, stdout: out.stream, stderr: err.stream });
    const rejected = assert.rejects(pending, { code: 'mcp_connection_failed' });
    await ready;
    input.write(frame);
    await rejected;
    input.destroy();
    assert.equal(out.text(), '');
    assert.ok(!err.text().includes(await state.secret()));
  }
  assert.equal(forwarded, 0);
});

test('proxy bounds partial frames before SDK buffering and releases the shared upload budget on close', { timeout: 5000 }, async t => {
  const state = await initialized(t);
  const inputs: PassThrough[] = [];
  const pending: Promise<unknown>[] = [];
  t.after(async () => { for (const input of inputs) input.end(); await Promise.allSettled(pending); });
  const start = async () => {
    const input = new PassThrough(); inputs.push(input);
    const ready = once(input, 'resume');
    const result = stdioProxy(state, { stdin: input, stdout: capture().stream, stderr: capture().stream });
    void result.catch(() => undefined); pending.push(result);
    await ready;
    return { input, result };
  };
  const first = await start(), second = await start(), third = await start();
  first.input.write('a'.repeat(LIMITS.bodyBytes + 1));
  second.input.write('a'.repeat(LIMITS.bodyBytes + 1));
  third.input.write('a'.repeat(LIMITS.bodyBytes + 1));
  await assert.rejects(third.result, { code: 'mcp_connection_failed' });
  first.input.end(); second.input.end();
  await Promise.all([first.result, second.result]);
  const bounded = await start();
  const chunk = Buffer.alloc(64 * 1024, 97);
  let bytes = 0, failed = false;
  void bounded.result.catch(() => { failed = true; });
  // Model a 4 GiB unterminated sender without allocating its declared payload.
  while (bytes <= LIMITS.uploadBodyBytes + chunk.length && !failed) {
    bounded.input.write(chunk); bytes += chunk.length;
    await new Promise<void>(done => setImmediate(done));
  }
  assert.ok(failed, 'a 4 GiB sender must already be rejected after the bounded prefix');
  await assert.rejects(bounded.result, { code: 'mcp_connection_failed' });
  assert.ok(bytes > LIMITS.uploadBodyBytes, 'a large partial upload gets the bounded allowance');
  assert.ok(bytes <= LIMITS.uploadBodyBytes + chunk.length, 'reject before buffering a 4 GiB partial frame');
  const recovered = await start();
  recovered.input.write('a'.repeat(LIMITS.bodyBytes + 1));
  recovered.input.end();
  await recovered.result;
});

test('proxy keeps large requests within the shared budget until authenticated HTTP sends settle', { timeout: 5000 }, async t => {
  const state = await initialized(t), token = await state.secret();
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'figma.upload_image', arguments: { lease: '00000000-0000-4000-8000-000000000001', filename: 'image.png',
      data_base64: paddedPng(160 * 1024).toString('base64'), trigger: { by: 'text', name: 'Upload' } },
  } }) + '\n';
  let forwarded = 0, resolvePosted!: () => void;
  const posted = new Promise<void>(done => { resolvePosted = done; });
  let resolveRecovered!: () => void;
  const recoveredPosted = new Promise<void>(done => { resolveRecovered = done; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `${DAEMON_URL}/mcp`);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, frame.trimEnd());
    if (++forwarded === 2) resolvePosted();
    if (forwarded === 3) resolveRecovered();
    return new Promise<Response>((_done, reject) => {
      const abort = () => reject(init!.signal!.reason);
      init!.signal!.addEventListener('abort', abort, { once: true });
      if (init!.signal!.aborted) abort();
    });
  });
  const running: { input: PassThrough; result: Promise<void> }[] = [];
  t.after(async () => { for (const entry of running) entry.input.end(); await Promise.allSettled(running.map(entry => entry.result)); });
  const start = async () => {
    const input = new PassThrough(), ready = once(input, 'resume');
    const result = stdioProxy(state, { stdin: input, stdout: capture().stream, stderr: capture().stream });
    void result.catch(() => undefined);
    const entry = { input, result }; running.push(entry);
    await ready;
    return entry;
  };
  const first = await start(), second = await start(), third = await start();
  first.input.write(frame); second.input.write(frame);
  await posted;
  third.input.write(frame);
  await assert.rejects(third.result, { code: 'mcp_connection_failed' });
  assert.equal(forwarded, 2, 'a third large call must not reach HTTP while two sends are pending');
  first.input.end(); second.input.end();
  await Promise.all([first.result, second.result]);
  const recovered = await start();
  recovered.input.write(frame);
  await recoveredPosted;
  recovered.input.end();
  await recovered.result;
  assert.equal(forwarded, 3, 'closed requests must release the shared budget');
});
