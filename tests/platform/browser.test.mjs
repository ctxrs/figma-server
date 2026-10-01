import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionModule, packageRoot } from './runtime.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { auditWindowsAcl } from './windows-acl.mjs';

const { State } = await productionModule('state');
const { BrowserSupervisor } = await productionModule('browser-supervisor');
import { firstKey, secondKey, file, pngSignature, attachFixture, launchFixture } from './fixture.mjs';

test('installed production supervisor: real sandboxed Chromium, isolated tabs, restart and crash', { timeout: 90_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma browser café space-')));
  const state = new State(root);
  const config = { version: 1, accounts: [{ name: 'default', loginOrigins: [] }],
    ...(process.env.QUALIFY_SYSTEM_BROWSER ? { browser: process.env.QUALIFY_SYSTEM_BROWSER } : {}) };
  await state.init(config);
  const supervisor = new BrowserSupervisor(state, config, launchFixture);
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  await supervisor.start();
  const worker = await attachFixture(supervisor);
  assert.equal(supervisor.status('default').state, 'needs_login');
  const context = worker.context;
  const browser = context.browser();
  assert.ok(browser?.isConnected());
  const version = browser.version();

  // Check the real launch arguments rather than assuming a fake launch enabled sandboxing.
  // chrome://version works without --enable-automation. This browser-owned
  // diagnostic tab is never leased or exposed through the agent API.
  const diagnostic = await context.newPage();
  await diagnostic.goto('chrome://version');
  const launchArguments = await diagnostic.locator('#command_line').innerText();
  assert.doesNotMatch(launchArguments, /(?:^|\s)--no-sandbox(?:\s|$)/);
  assert.doesNotMatch(launchArguments, /--remote-debugging-port(?:=|\s)/);
  await diagnostic.close();

  const [first, second] = await Promise.all([
    supervisor.open('default', file(firstKey), firstKey),
    supervisor.open('default', file(secondKey), secondKey),
  ]);
  assert.notEqual(first.target, second.target);
  assert.equal(first.generation, second.generation);
  await Promise.all([first.check(), second.check()]);
  assert.equal(supervisor.status('default').state, 'ready');
  await first.fill({ by: 'label', name: 'Description' }, 'Alpha isolated note');
  await second.fill({ by: 'label', name: 'Description' }, 'Beta isolated note');
  const [alpha, beta] = await Promise.all([first.inspect(), second.inspect()]);
  assert.ok(alpha.layers.includes('Alpha isolated note'));
  assert.ok(beta.layers.includes('Beta isolated note'));
  assert.ok(!alpha.layers.includes('Beta isolated note'));
  assert.ok(!beta.layers.includes('Alpha isolated note'));
  const [alphaPng, betaPng] = await Promise.all([first.screenshot(), second.screenshot()]);
  assert.deepEqual(alphaPng.subarray(0, 8), pngSignature);
  assert.deepEqual(betaPng.subarray(0, 8), pngSignature);
  assert.ok(!alphaPng.equals(betaPng), 'Different tabs must not return the same fixture screenshot.');
  const metrics = await first.metrics();
  assert.equal(metrics.width, 1920);
  assert.equal(metrics.height, 1200);
  assert.equal((await first.verify()).status, 'unverified');
  await first.click({ by: 'role', role: 'button', name: 'Add layer' });
  const firstPage = context.pages().find(page => page.url() === file(firstKey));
  assert.ok(firstPage);
  await firstPage.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await first.verify({ saved: true, locator: { by: 'text', name: 'Revision 1' } })).status, 'verified');
  assert.equal((await second.verify({ locator: { by: 'text', name: 'Revision 1' } })).status, 'unverified');

  // The fixture route handles only the permitted origin; production guards still block external navigation.
  await assert.rejects(firstPage.goto('https://example.invalid/'), /ERR_BLOCKED_BY_CLIENT/);
  await first.close();
  await assert.rejects(first.check());
  await second.close();
  const previousGeneration = worker.generation;
  await supervisor.stop();
  assert.equal(supervisor.status('default').state, 'stopped');
  const profile = state.path('accounts', 'default', 'profile');
  const windowsProfileAcl = await auditWindowsAcl([
    { path: profile, directory: true, protected: true },
    { path: join(profile, 'Default'), directory: true },
    { path: join(profile, 'Local State') }, { path: join(profile, 'Default/Preferences') },
  ]);
  await supervisor.start();
  const restarted = await attachFixture(supervisor);
  assert.notEqual(restarted.generation, previousGeneration);
  const persisted = await supervisor.open('default', file(firstKey), firstKey);
  assert.ok((await persisted.inspect()).layers.includes('Revision 1'), 'Same-machine fixture storage should survive reopening the dedicated profile.');
  await persisted.close();

  await assert.rejects(supervisor.open('default', file('PermissionDenied01'), 'PermissionDenied01'), error => error.code === 'permission_denied');
  assert.equal(supervisor.status('default').state, 'ready', 'One denied file must not poison account readiness.');
  await assert.rejects(supervisor.open('default', file('NeedsLogin01'), 'NeedsLogin01'), error => error.code === 'needs_login');
  assert.equal(supervisor.status('default').state, 'needs_login');
  const crashing = await supervisor.open('default', file(secondKey), secondKey);
  let crashes = 0;
  supervisor.onCrash = account => { assert.equal(account, 'default'); crashes++; };
  // Ask the owned browser for its PID, then actually terminate that process.
  // Browser.crash can leave a protocol request unresolved; an OS kill is a
  // clearer process-death test and does not generate a deliberate core dump.
  const crashSession = await restarted.context.browser().newBrowserCDPSession();
  const { processInfo } = await crashSession.send('SystemInfo.getProcessInfo');
  const browserProcess = processInfo.find(info => info.type === 'browser');
  assert.ok(Number.isInteger(browserProcess?.id) && browserProcess.id > 0 && browserProcess.id !== process.pid);
  await crashSession.detach();
  process.kill(browserProcess.id, 'SIGKILL');
  const until = Date.now() + 5000;
  while (supervisor.workers.size > 0 && Date.now() < until) await delay(20);
  assert.equal(supervisor.status('default').state, 'crashed');
  assert.equal(crashes, 1);
  await assert.rejects(crashing.check());
  assert.equal(supervisor.workers.size, 0);
  // A fresh supervisor can reuse the profile after the browser exits.
  const recovered = new BrowserSupervisor(state, config, launchFixture);
  try {
    await recovered.start();
    await attachFixture(recovered);
    const tab = await recovered.open('default', file(firstKey), firstKey);
    assert.ok((await tab.inspect()).layers.includes('Revision 1'));
    await tab.close();
  } finally { await recovered.stop(); }

  if (process.env.QUALIFY_OUTPUT) {
    await mkdir(process.env.QUALIFY_OUTPUT, { recursive: true });
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'fixture-alpha.png'), alphaPng);
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'fixture-beta.png'), betaPng);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'browser.json'), JSON.stringify({
      browser: version, playwright: manifest.dependencies.playwright,
      windowsProfileAcl,
      mode: config.browser ? 'system' : 'bundled', sandbox: 'no --no-sandbox argument observed',
      evidence: 'Local intercepted fixture only; no live Figma login, autosave or native export proof.',
    }, null, 2) + '\n');
  }
});
