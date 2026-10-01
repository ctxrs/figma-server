import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightTab, browserEnvironment } from '../src/browser-supervisor.js';
import { probe, verify, requireEditing } from '../src/figma-adapter.js';
import { State } from '../src/state.js';

const fixture = `<!doctype html><html><body>
<div role="toolbar"><button>Frame</button><button>Text</button></div>
<canvas width="1600" height="900" style="position:absolute;top:80px;left:0"></canvas>
<div role="tree" id="layers"></div><div role="status" id="save">Saving…</div>
<script>
let mode='', text=null; const layer=document.getElementById('layers'), save=document.getElementById('save');
function saved(){save.textContent='Saving…';setTimeout(()=>save.textContent='All changes saved',200)}
function node(name){let e=document.createElement('div');e.setAttribute('role','treeitem');e.textContent=name;layer.append(e);saved();return e}
document.addEventListener('keydown',e=>{if(e.target===document.body)mode=e.key.toLowerCase()});
document.querySelector('canvas').addEventListener('mouseup',e=>{
if(mode==='f'){node('Frame 1');mode=''}
else if(mode==='t'){let item=node('Text');text=document.createElement('div');text.setAttribute('role','textbox');text.setAttribute('aria-label','Canvas text');text.contentEditable='true';text.style='position:absolute;top:150px;left:400px';document.body.append(text);text.focus();text.oninput=()=>{item.textContent=text.textContent;saved()};mode=''}
});
setTimeout(()=>save.textContent='All changes saved',200);
</script></body></html>`;

test('real sandboxed Chromium fixture: native pointer/frame/text paths, page CDP and save probes', { timeout: 60_000 }, async t => {
  const executable = process.env.FIGMA_SERVER_TEST_BROWSER;
  if (!executable) { t.skip('Set FIGMA_SERVER_TEST_BROWSER to opt into isolated sandboxed Chromium fixture qualification.'); return; }
  try { await access(executable); } catch { t.skip('Install matching Chromium with figma-server browser-install or set FIGMA_SERVER_TEST_BROWSER for an isolated system-browser fixture.'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-browser-fixture-')));
  const state = new State(root);
  await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }] });
  const context = await chromium.launchPersistentContext(state.path('accounts', 'default', 'profile'), {
    executablePath: executable, channel: 'chromium', chromiumSandbox: true, headless: true, viewport: { width: 1920, height: 1200 },
    env: browserEnvironment(state), serviceWorkers: 'block', args: ['--disable-extensions'],
  });
  t.after(async () => { await context.close(); await rm(root, { recursive: true, force: true }); });
  // All traffic is fulfilled from a local fixture; no Figma account or copied profile.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const page = await context.newPage(); await page.goto('https://www.figma.com/design/fixture123');
  assert.equal(await probe(page, 'fixture123'), 'ready');
  await requireEditing(page);
  const tab = new PlaywrightTab(page, context, 'fixture123', 'fixture-generation', () => !page.isClosed());
  await tab.check(true);
  await tab.keypress('f'); await tab.drag({ x: 300, y: 200 }, { x: 700, y: 600 });
  await tab.keypress('t'); await tab.pointerClick({ x: 400, y: 300 }, 1, 'left');
  await tab.typeText('Native fixture text');
  await page.waitForTimeout(250);
  const inspection = await tab.inspect();
  assert.deepEqual(inspection.layers, ['Frame 1', 'Native fixture text']);
  assert.ok((inspection.controls as { name: string }[]).find(control => control.name === 'Frame'));
  assert.equal(await tab.readValue({ by: 'role', role: 'textbox', name: 'Canvas text' }), 'Native fixture text');
  await tab.wheel({ x: 500, y: 500 }, 0, 100);
  assert.equal((await tab.verify({ locator: { by: 'role', role: 'treeitem', name: 'Native fixture text' }, saved: true })).status, 'verified');
  assert.equal((await tab.metrics()).width, 1920);
  assert.ok((await tab.screenshot()).length > 100);
  const target = tab.target;
  await tab.reload(); assert.equal(tab.target, target); assert.equal(await probe(page, 'fixture123'), 'ready');
  // Save text inside a layer or hidden status is not trusted save evidence.
  await page.setContent('<div role="treeitem">All changes saved</div><div role="status" hidden>All changes saved</div>');
  assert.equal((await verify(page, { saved: true })).status, 'unverified');
  await page.setContent('<canvas></canvas><div role="toolbar"><button>Frame</button></div><div>View only</div>');
  await assert.rejects(requireEditing(page), /read-only/);
});

test('browser subprocess environment excludes inherited secrets', () => {
  process.env.FIGMA_SYNTHETIC_SECRET_FOR_TEST = 'shortsyntheticsecret';
  try { assert.equal(browserEnvironment(new State(join(tmpdir(), 'test-state'))).FIGMA_SYNTHETIC_SECRET_FOR_TEST, undefined); }
  finally { delete process.env.FIGMA_SYNTHETIC_SECRET_FOR_TEST; }
});
