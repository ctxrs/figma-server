import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { State } from '../src/state.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const playwright = pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href;
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`real CLI ${signal} awaits Chromium and lock cleanup, then restarts the same profile`, { timeout: 40_000 }, async t => {
    if (process.platform === 'win32' || !process.env.FIGMA_SERVER_TEST_BROWSER) {
      t.skip('Requires POSIX signals and an isolated system Chromium fixture.'); return;
    }
    const home = await realpath(await mkdtemp(join(tmpdir(), 'figma-signals-')));
    const root = process.platform === 'darwin' ? join(home, 'Library/Application Support/figma-server') : join(home, '.figma-server');
    const state = new State(root);
    await state.init({ version: 1, browser: process.env.FIGMA_SERVER_TEST_BROWSER, accounts: [{ name: 'default', loginOrigins: [] }] });
    const secret = await state.secret();
    const profile = state.path('accounts', 'default', 'profile');
    const retained = join(profile, 'fixture-retained.txt');
    await writeFile(retained, 'disposable fixture profile', { mode: 0o600 });
    const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
    t.after(async () => {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const source = `
      import assert from 'node:assert/strict';
      import os from 'node:os';
      import { Server } from 'node:http';
      import { syncBuiltinESMExports } from 'node:module';
      import playwright from ${JSON.stringify(playwright)};
      import { State } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
      // Private subprocess preload: the actual CLI keeps its default-root and
      // HTTP lifecycle, with fixture-only OS home resolution and port zero.
      const inheritedHome = process.env.HOME;
      os.homedir = () => ${JSON.stringify(home)};
      syncBuiltinESMExports();
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(port, host, ...args) {
        assert.equal(port, 4317); assert.equal(host, '127.0.0.1');
        return Reflect.apply(listen, this, [0, host, ...args]);
      };
      const { chromium } = playwright;
      const launch = chromium.launchPersistentContext.bind(chromium);
      chromium.launchPersistentContext = async (profile, options) => {
        assert.equal(options.chromiumSandbox, true);
        assert.equal(options.headless, true);
        const context = await launch(profile, options);
        context.on('close', () => process.stderr.write('FIXTURE_BROWSER_CLOSED\\n'));
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
          body: '<h1>Recents</h1><a href="/files/recents">Recents</a><button>New design file</button>' }));
        return context;
      };
      const lock = State.prototype.lock;
      State.prototype.lock = async function() {
        const unlock = await lock.call(this);
        return async () => {
          // A bounded slow filesystem cleanup makes competing process.exit
          // deterministic, while retaining the real lock ownership/unlock code.
          process.stderr.write('FIXTURE_UNLOCK_STARTED\\n');
          await new Promise(resolve => setTimeout(resolve, 150));
          await unlock();
        };
      };
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'run'];
      await import(${JSON.stringify(pathToFileURL(cli).href)});
      assert.equal(process.env.HOME, inheritedHome);
      process.stderr.write('FIXTURE_CLI_RETURNED\\n');
    `;
    for (let cycle = 0; cycle < 2; cycle++) {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
      children.push({ child, closed });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      const readyUntil = Date.now() + 10_000;
      while (!stderr.includes('Figma daemon ready')) {
        assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < readyUntil, stderr);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const url = /Figma daemon ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)?.[1];
      assert.ok(url); assert.notEqual(new URL(url).port, '4317');
      assert.ok(await exists(state.path('daemon.lock')));
      await assert.rejects(state.lock(), { code: 'daemon_locked' });
      assert.ok(child.kill(signal));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([closed, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10_000); })]);
      if (timer) clearTimeout(timer);
      assert.ok(exit, `CLI shutdown did not finish: ${stderr}`);
      const lockRemaining = await exists(state.path('daemon.lock'));
      const chromeLockRemaining = await exists(join(profile, 'SingletonLock'));
      t.diagnostic(JSON.stringify({ signal, cycle, code: exit[0], terminationSignal: exit[1], lockRemaining, chromeLockRemaining,
        browserClosed: stderr.includes('FIXTURE_BROWSER_CLOSED'), cliReturned: stderr.includes('FIXTURE_CLI_RETURNED') }));
      assert.equal(exit[0], 0, stderr);
      assert.equal(exit[1], null);
      assert.match(stderr, /FIXTURE_BROWSER_CLOSED/);
      assert.match(stderr, /FIXTURE_UNLOCK_STARTED/);
      assert.match(stderr, /FIXTURE_CLI_RETURNED/);
      assert.equal(lockRemaining, false);
      // Chromium may retain a dead-owner SingletonLock symlink. The second
      // actual launch on this same profile proves that ownership was released.
      assert.equal(await readFile(retained, 'utf8'), 'disposable fixture profile');
      assert.equal(await state.secret(), secret);
      const unlock = await state.lock(); await unlock();
    }
  });
}
