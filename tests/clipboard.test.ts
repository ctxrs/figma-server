import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserSupervisor } from '../src/browser-supervisor.js';
import { Core } from '../src/core.js';
import { Fault } from '../src/errors.js';
import type { Receipt } from '../src/receipts.js';
import { Metadata, State } from '../src/state.js';
import { open, setup } from './helpers.js';

const modifiers = ['Control', 'Meta', 'ControlOrMeta', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'];
const blocked = [
  ...modifiers.flatMap(modifier => ['C', 'X', 'V', 'KeyC', 'KeyX', 'KeyV'].flatMap(key =>
    ['', 'Shift+', 'Alt+', 'Shift+Alt+', 'ShiftLeft+AltRight+'].map(extra => `${modifier}+${extra}${key}`))),
  ...modifiers.flatMap(modifier => ['Insert', 'Shift+R', 'Shift+KeyR', 'ShiftRight+AltLeft+KeyR'].map(key => `${modifier}+${key}`)),
  'Shift+Insert', 'ShiftLeft+Insert', 'Alt+ShiftRight+Insert', 'Shift+Delete', 'ShiftLeft+Delete',
  'Control+ShiftRight+Delete', 'Copy', 'Cut', 'Paste', 'Alt+Copy',
  'Control+Numpad0', 'Shift+Numpad0', 'Shift+NumpadDecimal',
];
const malformed = [
  'Control+KeyC+ArrowLeft', 'Control+KeyX+ArrowLeft', 'Control+KeyV+ArrowLeft',
  'Meta+KeyV+ArrowLeft', 'ControlOrMeta+KeyX+Delete', 'Control+Shift+KeyR+ArrowLeft',
  'KeyC+Control', 'Copy+ArrowLeft', 'Control+Unknown+C', 'ControlOrMetaLeft+C',
  'Ctrl+v', 'Command+c', 'Ctrl+Insert', 'Control+', 'Control++A', '+',
];
const denied = (error: unknown): boolean => error instanceof Fault && error.code === 'shared_clipboard'
  && /figma.type_text.*figma.fill.*Duplicate/.test(error.message);
const invalidChord = (error: unknown): boolean => error instanceof Fault && error.code === 'invalid_keypress'
  && /one final key.*separate figma.keypress calls/.test(error.message);

test('clipboard chord table is rejected before checks, screenshots, artifacts or input; safe keys still dispatch', async t => {
  const env = await setup(); t.after(env.cleanup);
  const session = env.core.sessions.createSession();
  const lease = await open(env.core, session);
  const tab = env.browser.tabs[0]!;
  let checks = 0, screenshots = 0;
  const check = tab.check.bind(tab), screenshot = tab.screenshot.bind(tab);
  tab.check = async () => { checks++; await check(); };
  tab.screenshot = async () => { screenshots++; return screenshot(); };
  for (const keys of blocked) {
    await assert.rejects(env.core.call(session, 'figma.keypress', { lease: lease.lease, keys }), denied, keys);
  }
  for (const keys of malformed) {
    await assert.rejects(env.core.call(session, 'figma.keypress', { lease: lease.lease, keys }), invalidChord, keys);
  }
  assert.equal(checks, 0); assert.equal(screenshots, 0); assert.equal(tab.operations.length, 0);
  assert.deepEqual(await readdir(env.state.path('artifacts')), []);
  assert.equal(env.core.sessions.leases.has(lease.lease), true);
  for (const keys of ['Delete', 'Backspace', 'Control+D', 'Meta+D', 'ControlOrMeta+D', 'ControlLeft+KeyD', 'Shift+R', 'Control+A', 'ArrowLeft']) {
    const result = await env.core.call(session, 'figma.keypress', { lease: lease.lease, keys }) as { status: string };
    assert.equal(result.status, 'unverified', keys);
  }
  assert.equal(tab.operations.filter(operation => operation === 'keypress').length, 9);
  await env.core.call(session, 'figma.reload', { lease: lease.lease });
  assert.ok(tab.operations.includes('reload'));
});

for (const headless of [true, false]) {
  test(`real Core two-tab clipboard guard preserves fields and direct input (${headless ? 'headless' : 'headed'})`, { timeout: 60_000 }, async t => {
    if (!process.env.FIGMA_SERVER_TEST_BROWSER || (!headless && !process.env.FIGMA_SERVER_TEST_HEADED)) {
      t.skip('Set FIGMA_SERVER_TEST_BROWSER and use isolated Xvfb with FIGMA_SERVER_TEST_HEADED=1 for headed fixtures.'); return;
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-clipboard-fixture-')));
    const state = new State(root);
    await state.init({ version: 1, browser: process.env.FIGMA_SERVER_TEST_BROWSER, accounts: [{ name: 'default', loginOrigins: [] }] });
    let context!: BrowserContext;
    const launcher: typeof chromium.launchPersistentContext = async (profile, options) => {
      context = await chromium.launchPersistentContext(profile, { ...options, headless });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <div role="toolbar"><button>Frame</button></div><canvas width="800" height="500"></canvas>
        <input aria-label="Canvas text" value="${route.request().url().includes('second123') ? 'BETA' : 'ALPHA'}">
        <script>window.effects=0;for(const event of ['keydown','copy','cut','paste'])document.addEventListener(event,()=>window.effects++);</script>` }));
      return context;
    };
    const browser = new BrowserSupervisor(state, await state.config(), launcher);
    const core = new Core(browser, state, await Metadata.open(state));
    t.after(async () => { await core.stop(); await rm(root, { recursive: true, force: true }); });
    const a = core.sessions.createSession(), b = core.sessions.createSession();
    const first = await open(core, a), second = await open(core, b, 'second123');
    const locator = { by: 'role', role: 'textbox', name: 'Canvas text' } as const;
    const pages = context.pages().filter(page => page.url().includes('/design/'));
    assert.equal(pages.length, 2);
    const read = async (session: string, lease: string) => (await core.call(session, 'figma.read_value', { lease, locator }) as { value: string }).value;
    const mutate = async (session: string, name: string, args: unknown) => {
      const receipt = await core.call(session, name, args) as Receipt;
      assert.ok(receipt.status === 'verified' || receipt.status === 'unverified', `${name}: ${JSON.stringify(receipt)}`);
    };
    await mutate(a, 'figma.click', { lease: first.lease, locator });
    await mutate(a, 'figma.keypress', { lease: first.lease, keys: 'ControlOrMeta+A' });
    await mutate(b, 'figma.click', { lease: second.lease, locator });
    await mutate(b, 'figma.keypress', { lease: second.lease, keys: 'ControlOrMeta+A' });
    const before = await Promise.all(pages.map(page => page.evaluate(() => (window as unknown as { effects: number }).effects)));
    const jobs = await readdir(state.path('artifacts'));
    for (const keys of ['ControlOrMeta+C', 'ControlOrMeta+X', 'ControlOrMeta+V', 'ControlOrMeta+Shift+R']) {
      await assert.rejects(core.call(a, 'figma.keypress', { lease: first.lease, keys }), denied);
      await assert.rejects(core.call(b, 'figma.keypress', { lease: second.lease, keys }), denied);
    }
    for (const keys of malformed) {
      await assert.rejects(core.call(a, 'figma.keypress', { lease: first.lease, keys }), invalidChord, keys);
      await assert.rejects(core.call(b, 'figma.keypress', { lease: second.lease, keys }), invalidChord, keys);
    }
    assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => (window as unknown as { effects: number }).effects))), before);
    assert.deepEqual(await readdir(state.path('artifacts')), jobs);
    assert.equal(await read(a, first.lease), 'ALPHA'); assert.equal(await read(b, second.lease), 'BETA');
    await mutate(a, 'figma.type_text', { lease: first.lease, text: 'DIRECT_A' });
    await mutate(b, 'figma.type_text', { lease: second.lease, text: 'DIRECT_B' });
    assert.equal(await read(a, first.lease), 'DIRECT_A'); assert.equal(await read(b, second.lease), 'DIRECT_B');
    await mutate(a, 'figma.fill', { lease: first.lease, locator, text: 'FILLED_A' });
    assert.equal(await read(a, first.lease), 'FILLED_A'); assert.equal(await read(b, second.lease), 'DIRECT_B');
    const target = core.sessions.get(a, first.lease).target;
    await core.call(a, 'figma.reload', { lease: first.lease });
    assert.equal(core.sessions.get(a, first.lease).target, target);
  });
}
