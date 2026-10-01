import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { PlaywrightTab } from '../src/browser-supervisor.js';
import { modifierKeys } from '../src/security.js';
import { editorFixture, open, setup, tick } from './helpers.js';

test('modifier schema denies arbitrary/duplicate values before effects and resolves native aliases once', async t => {
  const env = await setup(); t.after(env.cleanup);
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const tab = env.browser.tabs[0]!;
  let effects = 0;
  const screenshot = tab.screenshot.bind(tab);
  tab.screenshot = async () => { effects++; return screenshot(); };
  for (const modifiers of [['Shift', 'Shift'], ['Control+V'], ['ShiftLeft'], ['Escape'], 'Shift']) {
    await assert.rejects(env.core.call(session, 'figma.pointer_click', { lease: lease.lease, point: { x: 100, y: 100 }, modifiers }));
  }
  assert.equal(effects, 0); assert.deepEqual(await readdir(env.state.path('artifacts')), []);
  assert.deepEqual(modifierKeys(['Control', 'ControlOrMeta', 'Shift'], 'linux'), ['Control', 'Shift']);
  assert.deepEqual(modifierKeys(['Control', 'ControlOrMeta'], 'win32'), ['Control']);
  assert.deepEqual(modifierKeys(['Meta', 'ControlOrMeta', 'Alt'], 'darwin'), ['Meta', 'Alt']);
});

const fixture = `<!doctype html><div role="toolbar"><button>Frame</button></div>
<button id="select">Select</button><button disabled>Disabled</button><canvas width="1200" height="600"></canvas>
<script>window.events=[];window.keys=0;document.addEventListener('keydown',()=>window.keys++);
for(const type of ['mousedown','mouseup','mousemove','click'])document.addEventListener(type,e=>window.events.push({type,shift:e.shiftKey,alt:e.altKey,control:e.ctrlKey,meta:e.metaKey,buttons:e.buttons}));</script>`;
type MouseEvent = { type: string; shift: boolean; alt: boolean; control: boolean; meta: boolean; buttons: number };
const plain = (event: MouseEvent) => !event.shift && !event.alt && !event.control && !event.meta;

for (const headed of [false, true]) test(`owned click/drag modifiers span actual mouse events and release afterward (${headed ? 'headed' : 'headless'})`, { timeout: 60_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_BROWSER || (headed && !process.env.FIGMA_SERVER_TEST_HEADED)) { t.skip('Enable sandboxed fixture browser and isolated headed display.'); return; }
  const env = await editorFixture(fixture, headed); t.after(env.cleanup);
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const page = env.context().pages().find(page => page.url().includes('/design/'))!;
  if (headed) await page.bringToFront(); // Only the isolated Xvfb fixture display.
  const events = () => page.evaluate(() => (window as unknown as { events: MouseEvent[] }).events);
  const clear = () => page.evaluate(() => { (window as unknown as { events: MouseEvent[] }).events = []; });
  await env.core.call(session, 'figma.click', { lease: lease.lease, locator: { by: 'role', role: 'button', name: 'Select' }, modifiers: ['Shift', 'Alt'] });
  assert.ok((await events()).filter(event => event.type === 'mousedown' || event.type === 'click').every(event => event.shift && event.alt));
  await clear();
  await env.core.call(session, 'figma.pointer_click', { lease: lease.lease, point: { x: 100, y: 150 }, modifiers: ['ControlOrMeta', process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const pointer = (await events()).find(event => event.type === 'mousedown')!;
  assert.ok(pointer); assert.equal(pointer.control, process.platform !== 'darwin'); assert.equal(pointer.meta, process.platform === 'darwin');
  await clear();
  await env.core.call(session, 'figma.drag', { lease: lease.lease, from: { x: 100, y: 150 }, to: { x: 350, y: 250 }, modifiers: ['Shift', 'Alt'] });
  const drag = (await events()).filter(event => event.type === 'mousedown' || event.buttons === 1 || event.type === 'mouseup');
  assert.ok(drag.length > 5); assert.ok(drag.every(event => event.shift && event.alt)); assert.equal(drag.at(-1)!.buttons, 0);
  await clear();
  await env.core.call(session, 'figma.pointer_click', { lease: lease.lease, point: { x: 100, y: 150 } });
  assert.ok((await events()).every(plain));
  const other = env.core.sessions.createSession(), otherLease = await open(env.core, other, 'modifier002');
  await env.core.call(other, 'figma.pointer_click', { lease: otherLease.lease, point: { x: 100, y: 150 } });
  const otherPage = env.context().pages().find(page => page.url().includes('modifier002'))!;
  assert.ok((await otherPage.evaluate(() => (window as unknown as { events: MouseEvent[] }).events)).every(plain));
});

test('failed drag releases mouse/modifier state; cancelled held click closes page before another lease enters', { timeout: 30_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_BROWSER) { t.skip('Enable isolated sandboxed fixture browser.'); return; }
  const env = await editorFixture(fixture); t.after(env.cleanup);
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const page = env.context().pages().find(page => page.url().includes('/design/'))!;
  const tab = env.core.sessions.get(session, lease.lease).tab as PlaywrightTab;
  const move = page.mouse.move.bind(page.mouse);
  let moves = 0;
  page.mouse.move = async (...args) => { if (++moves === 2) throw new Error('fixture interrupted drag'); await move(...args); };
  try { await assert.rejects(tab.drag({ x: 100, y: 150 }, { x: 350, y: 250 }, ['Shift', 'Alt']), /interrupted/); }
  finally { page.mouse.move = move; }
  const down = page.mouse.down.bind(page.mouse);
  page.mouse.down = async (...args) => { await down(...args); throw new Error('fixture down response failed'); };
  try { await assert.rejects(tab.drag({ x: 100, y: 150 }, { x: 350, y: 250 }, ['Shift', 'Alt']), /down response/); }
  finally { page.mouse.down = down; }
  await page.evaluate(() => { (window as unknown as { events: MouseEvent[] }).events = []; });
  await tab.pointerClick({ x: 100, y: 150 }, 1, 'left');
  assert.ok((await page.evaluate(() => (window as unknown as { events: MouseEvent[] }).events)).every(plain));
  const abort = new AbortController();
  const pending = env.core.call(session, 'figma.click', { lease: lease.lease, locator: { by: 'role', role: 'button', name: 'Disabled' }, modifiers: ['Shift', 'Alt'] }, abort.signal);
  await page.waitForFunction(() => (window as unknown as { keys: number }).keys >= 6);
  abort.abort();
  assert.equal((await pending as { status: string }).status, 'indeterminate');
  assert.equal(page.isClosed(), true);
  const replacement = await open(env.core, session);
  await tick();
  await env.core.call(session, 'figma.pointer_click', { lease: replacement.lease, point: { x: 100, y: 150 } });
  const fresh = env.context().pages().find(page => page.url().includes('/design/'))!;
  assert.ok((await fresh.evaluate(() => (window as unknown as { events: MouseEvent[] }).events)).every(plain));
});
