import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { productionModule } from './runtime.mjs';
import { firstKey, secondKey, file, attachFixture } from './fixture.mjs';
import { launchPrimitives } from './primitives-fixture.mjs';
import { installedStdio } from './stdio-client.mjs';
import { auditWindowsAcl } from './windows-acl.mjs';

const { State, Metadata } = await productionModule('state');
const { BrowserSupervisor } = await productionModule('browser-supervisor');
const { Core } = await productionModule('core');
const { serve } = await productionModule('main');
const { LIMITS } = await productionModule('security');
const trigger = { by: 'role', role: 'button', name: 'Upload image' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = event => !event.shift && !event.alt && !event.control && !event.meta;

test('installed upload bytes, native held modifiers and bounded stdio frames', { timeout: 240_000 }, async t => {
  assert.ok(process.env.QUALIFY_CONSUMER, 'Run the installed archive through scripts/qualify.mjs.');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'figma primitives café space-')));
  const root = process.platform === 'win32' ? join(home, 'AppData/Local/figma-server')
    : process.platform === 'darwin' ? join(home, 'Library/Application Support/figma-server') : join(home, '.figma-server');
  const state = new State(root);
  const config = { version: 1, accounts: [{ name: 'default', loginOrigins: [] }],
    ...(process.env.QUALIFY_SYSTEM_BROWSER ? { browser: process.env.QUALIFY_SYSTEM_BROWSER } : {}) };
  await state.init(config);
  const browser = new BrowserSupervisor(state, config, launchPrimitives);
  const core = new Core(browser, state, await Metadata.open(state));
  const token = await state.secret();
  const connections = [];
  let daemon;
  t.after(async () => {
    try { for (const connection of connections) await connection.cleanup(); }
    finally { try { await daemon?.close(); } finally { await core.stop(); await rm(home, { recursive: true, force: true }); } }
  });
  await browser.start();
  const worker = await attachFixture(browser);
  // Fixed product proxy port: EADDRINUSE is a blocked fixture, never reuse an operator daemon.
  daemon = await serve(core, { token, accounts: ['default'] });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
  const shim = join(process.env.QUALIFY_CONSUMER, 'node_modules/.bin', process.platform === 'win32' ? 'figma-server.cmd' : 'figma-server');
  const connect = async () => {
    const value = await installedStdio({ shim, cwd: home, env }); connections.push(value); return value;
  };
  const stdio = await connect();
  const tool = async (name, arguments_) => {
    const result = await stdio.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 45_000 });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content.find(part => part.type === 'text').text);
  };
  const alpha = await tool('figma.open', { file_url: file(firstKey), mode: 'write' });
  const session = core.sessions.createSession();
  const beta = await core.call(session, 'figma.open', { file_url: file(secondKey), mode: 'write' });
  const pageA = worker.context.pages().find(page => page.url() === file(firstKey));
  const pageB = worker.context.pages().find(page => page.url() === file(secondKey));
  assert.ok(pageA && pageB);
  const post = (name, args) => fetch(`${daemon.url}/api/tools/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Figma-Session': session },
    body: JSON.stringify(args), signal: AbortSignal.timeout(45_000), redirect: 'error',
  });

  // Valid browser-encoded PNG/JPEG; deterministic noise yields a genuine large PNG.
  const encoded = await pageA.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d'), pixels = context.createImageData(256, 256);
    let seed = 1;
    for (let i = 0; i < pixels.data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24; }
    context.putImageData(pixels, 0, 0);
    const png = canvas.toDataURL('image/png').split(',')[1];
    canvas.width = 20; canvas.height = 15; context.fillStyle = '#d42'; context.fillRect(0, 0, 20, 15);
    return { png, smallPng: canvas.toDataURL('image/png').split(',')[1], jpeg: canvas.toDataURL('image/jpeg').split(',')[1] };
  });
  const png = Buffer.from(encoded.png, 'base64'), jpeg = Buffer.from(encoded.jpeg, 'base64');
  const upload = { lease: alpha.lease, filename: 'supplied.png', data_base64: encoded.png, trigger };
  const uploadFrameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'figma.upload_image', arguments: upload } }));
  assert.ok(uploadFrameBytes > LIMITS.bodyBytes && uploadFrameBytes < LIMITS.uploadBodyBytes);
  const before = await readdir(state.path('artifacts'));
  const tab = core.sessions.leases.get(alpha.lease).tab;
  const screenshot = tab.screenshot.bind(tab); let screenshotEffects = 0;
  tab.screenshot = async (...args) => { screenshotEffects++; return screenshot(...args); };
  try {
    for (const filename of ['../private.png', 'C:\\private.png', 'CON.png', 'COM1.x.png', 'bad\n.png', 'image.svg']) {
      const result = await stdio.client.callTool({ name: 'figma.upload_image', arguments: { ...upload, data_base64: encoded.smallPng, filename } });
      assert.equal(result.isError, true);
    }
    assert.equal(screenshotEffects, 0, 'Invalid filenames must fail before receipt screenshots.');
  } finally { tab.screenshot = screenshot; }
  assert.deepEqual(await readdir(state.path('artifacts')), before);
  assert.equal(await pageA.evaluate(() => window.chooserTriggers), 0);
  assert.deepEqual(await pageB.evaluate(() => window.uploads), []);
  const chooserListeners = pageA.listenerCount('filechooser');
  const alphaReceipt = await tool('figma.upload_image', upload);
  assert.equal(alphaReceipt.status, 'unverified', 'Input dispatch alone must not claim a saved native image.');
  const response = await post('figma.upload_image', { lease: beta.lease, filename: 'replacement.jpg', data_base64: encoded.jpeg, trigger });
  assert.equal(response.status, 200); const betaReceipt = await response.json();
  assert.equal(betaReceipt.status, 'unverified');
  await pageA.waitForFunction(() => window.uploads.length === 1);
  await pageB.waitForFunction(() => window.uploads.length === 1);
  assert.deepEqual(await pageA.evaluate(() => window.uploads), [{ name: 'supplied.png', type: 'image/png', size: png.length, hash: digest(png), width: 256, height: 256 }]);
  assert.deepEqual(await pageB.evaluate(() => window.uploads), [{ name: 'replacement.jpg', type: 'image/jpeg', size: jpeg.length, hash: digest(jpeg), width: 20, height: 15 }]);
  assert.equal(pageA.listenerCount('filechooser'), chooserListeners);
  for (const receipt of [alphaReceipt, betaReceipt]) {
    const stored = await readFile(state.path('artifacts', receipt.jobId, 'receipt.json'), 'utf8');
    for (const sensitive of [encoded.png, encoded.jpeg, 'supplied.png', 'replacement.jpg']) assert.ok(!stored.includes(sensitive));
  }

  const clear = () => pageA.evaluate(() => { window.events = []; });
  const events = () => pageA.evaluate(() => window.events);
  await clear();
  await tool('figma.click', { lease: alpha.lease, locator: { by: 'role', role: 'button', name: 'Select' }, modifiers: ['Shift', 'Alt'] });
  const clicked = (await events()).filter(event => event.type === 'mousedown' || event.type === 'mouseup');
  assert.ok(clicked.length >= 2 && clicked.every(event => event.shift && event.alt));
  await clear();
  const nativeKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await tool('figma.pointer_click', { lease: alpha.lease, point: { x: 100, y: 180 }, modifiers: ['ControlOrMeta', nativeKey] });
  const pointer = (await events()).find(event => event.type === 'mousedown');
  assert.ok(pointer); assert.equal(pointer.meta, process.platform === 'darwin'); assert.equal(pointer.control, process.platform !== 'darwin');
  await clear();
  await tool('figma.drag', { lease: alpha.lease, from: { x: 100, y: 180 }, to: { x: 350, y: 250 }, modifiers: ['Shift', 'Alt'] });
  const dragged = (await events()).filter(event => event.type === 'mousedown' || event.buttons === 1 || event.type === 'mouseup');
  assert.ok(dragged.length > 5 && dragged.every(event => event.shift && event.alt));
  assert.equal(dragged.at(-1).buttons, 0);
  // One injected browser-protocol failure verifies release on the real page as well.
  const move = pageA.mouse.move.bind(pageA.mouse); let moves = 0;
  pageA.mouse.move = async (...args) => { if (++moves === 2) throw new Error('qualification interrupted drag'); await move(...args); };
  try { await assert.rejects(tab.drag({ x: 100, y: 180 }, { x: 350, y: 250 }, ['Shift', 'Alt']), /interrupted drag/); }
  finally { pageA.mouse.move = move; }
  await clear();
  await tool('figma.pointer_click', { lease: alpha.lease, point: { x: 100, y: 180 } });
  assert.ok((await events()).length > 0 && (await events()).every(plain));
  await pageB.evaluate(() => { window.events = []; });
  await core.call(session, 'figma.pointer_click', { lease: beta.lease, point: { x: 100, y: 180 } });
  assert.ok((await pageB.evaluate(() => window.events)).every(plain));

  assert.equal(stdio.errors.length, 0, 'Stdout must contain only valid MCP frames.');
  assert.deepEqual(await stdio.exit({ eof: true }), [0, null]);
  assert.equal(pageA.isClosed(), true);
  assert.equal(core.sessions.sessions.size, 1); assert.equal(core.sessions.leases.size, 1);
  const rejected = await connect();
  const ordinary = { name: 'figma.fill', arguments: { lease: beta.lease, locator: trigger, text: 'x'.repeat(LIMITS.bodyBytes) } };
  assert.ok(Buffer.byteLength(JSON.stringify(ordinary)) > LIMITS.bodyBytes);
  const jobsBeforeCap = await readdir(state.path('artifacts'));
  await assert.rejects(rejected.client.callTool(ordinary, undefined, { timeout: 10_000 }));
  assert.deepEqual(await rejected.exit({ eof: true }), [1, null], 'An oversized ordinary frame must fail and exit after the client closes stdin.');
  assert.deepEqual(await readdir(state.path('artifacts')), jobsBeforeCap);
  assert.equal(core.sessions.sessions.size, 1); assert.equal(core.sessions.leases.size, 1);
  for (const connection of connections) {
    assert.ok(!connection.diagnostics().includes(token));
    assert.ok(!connection.diagnostics().includes(encoded.png));
  }
  const windowsAcl = await auditWindowsAcl([
    { path: root, directory: true, protected: true }, { path: state.path('secret'), protected: true },
    { path: state.path('accounts', 'default', 'profile'), directory: true, protected: true },
    { path: state.path('metadata.sqlite'), protected: true },
    ...[alphaReceipt, betaReceipt].flatMap(receipt => ['receipt.json', 'before.png', 'after.png']
      .map(name => ({ path: state.path('artifacts', receipt.jobId, name), protected: true }))),
  ]);
  await core.sessions.release(session, beta.lease);
  await core.sessions.closeSession(session);
  assert.equal(core.sessions.sessions.size, 0); assert.equal(core.sessions.leases.size, 0);
  if (process.env.QUALIFY_OUTPUT) {
    await mkdir(process.env.QUALIFY_OUTPUT, { recursive: true });
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'primitives.json'), JSON.stringify({
      platform: process.platform, node: process.version, browser: worker.context.browser().version(),
      browserMode: config.browser ? 'system' : 'bundled', uploadFrameBytes,
      imageByteHashesMatch: true, pngJpegTabsIsolated: true, unsafeFilenameBeforeEffects: true,
      fileChooserListenersRestored: true, receiptOmitsUploadBytesAndNames: true,
      controlOrMetaResolved: nativeKey, clickAndDragModifiersHeld: true, modifiersReleasedAfterFailure: true,
      stdioLargeUpload: 'accepted', ordinaryFrameCap: LIMITS.bodyBytes, ordinaryOversizeExit: 1, ordinaryRejectionStdinClosed: true,
      acceptedUploadEOFExit: 0, remainingSessions: 0, remainingLeases: 0, windowsAcl,
      scope: 'Real sandboxed browser with intercepted fixture; no authenticated Figma image insertion/save proof.',
    }, null, 2) + '\n');
  }
});
