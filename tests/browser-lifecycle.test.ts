import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserSupervisor } from '../src/browser-supervisor.js';
import { State } from '../src/state.js';

test('headed login reuses initial window, closes before headless restart, and preserves dashboard evidence', { timeout: 60_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_HEADED || !process.env.FIGMA_SERVER_TEST_BROWSER) {
    t.skip('Run with FIGMA_SERVER_TEST_HEADED=1 and an isolated Xvfb display/system browser for headed lifecycle qualification.'); return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-headed-fixture-')));
  const state = new State(root);
  await state.init({ version: 1, browser: process.env.FIGMA_SERVER_TEST_BROWSER, accounts: [{ name: 'default', loginOrigins: ['https://sso.fixture.invalid'] }] });
  const contexts: BrowserContext[] = [];
  const modes: boolean[] = [];
  let live = 0;
  const launcher: typeof chromium.launchPersistentContext = async (profile, options) => {
    assert.equal(live, 0, 'Never launch two processes on one profile.');
    assert.equal(options?.chromiumSandbox, true); assert.equal(options?.channel, 'chromium');
    const context = await chromium.launchPersistentContext(profile, options);
    contexts.push(context); modes.push(options?.headless ?? true); live++;
    context.on('close', () => { live--; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/login' ? '<label>Email<input aria-label="Email"></label><button id="sso" onclick="window.open(\'https://sso.fixture.invalid/authorize\')">SSO</button>'
        : url.origin === 'https://sso.fixture.invalid' ? '<h1>Fixture SSO</h1>'
        : '<h1>Recents</h1><a href="/files/recents">Recents</a><button>New design file</button>';
      await route.fulfill({ contentType: 'text/html', body });
    });
    return context;
  };
  const browser = new BrowserSupervisor(state, await state.config(), launcher);
  t.after(async () => { await browser.stop(); await rm(root, { recursive: true, force: true }); });
  const login = await browser.login('default', async () => {
    const context = contexts[0]!;
    const page = context.pages().find(p => p.url().endsWith('/login'))!;
    assert.ok(page); assert.ok(!page.isClosed()); assert.equal(context.pages().length, 1);
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'SSO' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), 'https://sso.fixture.invalid/authorize');
    assert.ok(!popup.isClosed(), 'Configured human SSO popup must remain usable.');
  });
  assert.equal(login.state, 'authenticated_unverified');
  assert.deepEqual(modes, [false, true]);
  assert.equal(live, 1);
  await browser.stop(); assert.equal(live, 0);
  await browser.start();
  assert.equal(browser.status('default').state, 'authenticated_unverified');
});
