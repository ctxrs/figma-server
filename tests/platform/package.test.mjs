import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, mkdtemp, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { auditWindowsAcl } from './windows-acl.mjs';
import { packageRoot, productionDirectory, runNode, productionModule } from './runtime.mjs';

const require = createRequire(join(packageRoot, 'package.json'));
const { chromium } = require('playwright');
// Preserve the browser cache while moving CLI state to a disposable HOME.
let browserDirectory = chromium.executablePath();
while (!/^chromium-[0-9]+$/.test(basename(browserDirectory))) {
  const parent = dirname(browserDirectory);
  assert.notEqual(parent, browserDirectory, 'Cannot locate the installed Playwright browser cache.');
  browserDirectory = parent;
}
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? dirname(browserDirectory);

test('packed production dependencies and bin resolve outside the checkout', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@ctxrs/figma-server');
  const cli = join(packageRoot, manifest.bin['figma-server']);
  await access(cli);
  await access(join(productionDirectory, 'browser-supervisor.js'));
  if (process.env.QUALIFY_CONSUMER) {
    await access(join(process.env.QUALIFY_CONSUMER, 'node_modules/.bin', process.platform === 'win32' ? 'figma-server.cmd' : 'figma-server'));
    await assert.rejects(access(join(process.env.QUALIFY_CONSUMER, 'node_modules/typescript')));
  }
  const home = await realpath(await mkdtemp(join(tmpdir(), 'figma-cli-home-')));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: browserCache,
      APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
      XDG_DATA_HOME: join(home, 'data') };
    const help = runNode([cli, '--help'], { cwd: home, env, capture: true, timeout: 10_000 });
    assert.match(help, /figma-server|Usage/i);
    const initialized = runNode([cli, 'init', ...(process.env.QUALIFY_SYSTEM_BROWSER
      ? ['--browser', process.env.QUALIFY_SYSTEM_BROWSER] : [])], { cwd: home, env, capture: true, timeout: 60_000 });
    assert.match(initialized, /Initialized/);
    const root = process.platform === 'win32' ? join(home, 'AppData/Local/figma-server')
      : process.platform === 'darwin' ? join(home, 'Library/Application Support/figma-server')
      : join(home, '.figma-server');
    await access(join(root, 'accounts/default/profile'));
    const secret = (await readFile(join(root, 'secret'), 'utf8')).trim();
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.ok(!help.includes(secret) && !initialized.includes(secret));
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'secret'))).mode & 0o777, 0o600);
    else await auditWindowsAcl([
      { path: root, directory: true, protected: true },
      { path: join(root, 'accounts/default/profile'), directory: true, protected: true },
      { path: join(root, 'secret'), protected: true }, { path: join(root, 'config.json'), protected: true },
    ]);
    // Doctor uses the fixed daemon port. Simulate a refused listener in this
    // child only, so no request or temporary token reaches another local task.
    const doctor = runNode(['--input-type=module', '--eval', `
      const { runCli } = await import(${JSON.stringify(pathToFileURL(cli).href)});
      globalThis.fetch = async () => { const error = new Error('fixture offline'); error.cause = { code: 'ECONNREFUSED' }; throw error; };
      process.exitCode = await runCli(['doctor']);
    `], { cwd: home, env, capture: true, timeout: 60_000, expectedStatus: 1 });
    assert.match(doctor, /Private state: OK/);
    assert.match(doctor, /Chromium: found/);
    assert.match(doctor, /Daemon: stopped/);
    const { State } = await productionModule('state');
    const state = new State(root);
    const unlock = await state.lock();
    try { await assert.rejects(new State(root).lock(), error => error.code === 'daemon_locked'); }
    finally { await unlock(); }
    const unlockAgain = await state.lock();
    await unlockAgain();
  } finally { await rm(home, { recursive: true, force: true }); }
});
