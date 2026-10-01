import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import test from 'node:test';
import type { Page } from 'playwright';
import { Fault } from '../src/errors.js';
import { serve } from '../src/main.js';
import { LIMITS, suppliedImage } from '../src/security.js';
import { PNG, editorFixture, open, setup, tick } from './helpers.js';

const trigger = { by: 'role', role: 'button', name: 'Upload image' } as const;
const image = { filename: 'image.png', data_base64: PNG.toString('base64'), trigger };
const chooserListeners = (page: Page) => (page as unknown as { listenerCount: (event: string) => number }).listenerCount('filechooser');
function largePng(): Buffer {
  const chunk = Buffer.alloc(160 * 1024 + 12);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write('tEXt', 4);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}

test('supplied image validation denies paths, non-images, noncanonical base64, oversize and unsafe dimensions before effects', async t => {
  const env = await setup(); t.after(env.cleanup);
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const tab = env.browser.tabs[0]!;
  let effects = 0;
  tab.screenshot = async () => { effects++; return PNG; };
  tab.uploadImage = async () => { effects++; };
  const dimension = Buffer.from(PNG); dimension.writeUInt32BE(8193, 16);
  const pixels = Buffer.from(PNG); pixels.writeUInt32BE(8192, 16); pixels.writeUInt32BE(4096, 20);
  const allowed = Buffer.from(PNG); allowed.writeUInt32BE(4096, 16); allowed.writeUInt32BE(4096, 20);
  assert.equal(suppliedImage('4k.png', allowed.toString('base64')).mimeType, 'image/png');
  const bad = [
    ...['../image.png', 'C:\\image.png', '/image.png', 'con.png', 'COM1.x.png', 'NUL.jpg', 'image\n.png', 'image.svg', 'image.jpg'].map(filename => ({ filename })),
    ...['https://example.test/image.png', `${image.data_base64}\n`, 'AB==', Buffer.from('<svg/>').toString('base64'),
      PNG.subarray(0, -1).toString('base64'), dimension.toString('base64'), pixels.toString('base64'),
      Buffer.alloc(LIMITS.imageBytes + 1).toString('base64')].map(data_base64 => ({ data_base64 })),
    { path: '/private/credentials.png' }, { url: 'https://example.test/image.png' },
  ];
  for (const fields of bad) await assert.rejects(env.core.call(session, 'figma.upload_image', { ...image, ...fields, lease: lease.lease }), error => error instanceof Fault);
  assert.equal(effects, 0); assert.deepEqual(await readdir(env.state.path('artifacts')), []);
  assert.equal(env.core.sessions.leases.has(lease.lease), true);
  await assert.rejects(env.core.call('not-a-session', 'figma.upload_image', { ...image, lease: lease.lease }), /Session/);
});

test('upload capacity retains cancelled browser bytes until work settles; receipts store neither bytes nor filenames', async t => {
  const env = await setup();
  const session = env.core.sessions.createSession();
  const leases = await Promise.all(['image001', 'image002', 'image003'].map(file => open(env.core, session, file)));
  let finish!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  t.after(async () => { finish(); await env.cleanup(); });
  for (const tab of env.browser.tabs.slice(0, 2)) tab.uploadImage = async () => { started++; await gate; await tab.check(); };
  const abort = new AbortController();
  const a = env.core.call(session, 'figma.upload_image', { ...image, filename: 'shortsyntheticsecret.png', lease: leases[0]!.lease }, abort.signal);
  const b = env.core.call(session, 'figma.upload_image', { ...image, lease: leases[1]!.lease });
  for (let i = 0; i < 100 && started < 2; i++) await tick();
  assert.equal(started, 2);
  await assert.rejects(env.core.call(session, 'figma.upload_image', { ...image, lease: leases[2]!.lease }), (error: unknown) => error instanceof Fault && error.code === 'upload_limit');
  abort.abort();
  const result = await a as { status: string; jobId: string }; assert.equal(result.status, 'indeterminate');
  await assert.rejects(env.core.call(session, 'figma.upload_image', { ...image, lease: leases[2]!.lease }), /capacity/);
  finish(); await b; await tick();
  assert.equal((await env.core.call(session, 'figma.upload_image', { ...image, lease: leases[2]!.lease }) as { status: string }).status, 'unverified');
  const receipt = await readFile(env.state.path('artifacts', result.jobId, 'receipt.json'), 'utf8');
  assert.equal(receipt.includes(image.data_base64), false); assert.equal(receipt.includes('shortsyntheticsecret'), false);
});

test('authenticated JSON/MCP upload bodies exceed ordinary cap while other tools, total size and concurrent readers stay bounded', { timeout: 10_000 }, async t => {
  const env = await setup(); const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  const pending: ReturnType<typeof request>[] = [];
  t.after(async () => { for (const req of pending) req.destroy(); await daemon.close(); await env.cleanup(); });
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Figma-Session': session };
  const payload = JSON.stringify({ ...image, data_base64: largePng().toString('base64'), lease: lease.lease });
  assert.ok(Buffer.byteLength(payload) > LIMITS.bodyBytes);
  const padded = ' '.repeat(LIMITS.bodyBytes) + JSON.stringify({ ...image, lease: lease.lease });
  assert.equal((await fetch(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers, body: padded })).status, 413);
  assert.deepEqual(await readdir(env.state.path('artifacts')), []);
  assert.equal((await fetch(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body: payload })).status, 401);
  const uploaded = await fetch(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers, body: payload });
  assert.equal(uploaded.status, 200); assert.equal((await uploaded.json() as { status: string }).status, 'unverified');
  assert.equal((await fetch(`${daemon.url}/api/tools/figma.fill`, { method: 'POST', headers, body: payload })).status, 413);
  const oversized = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers: { ...headers, 'Content-Length': LIMITS.uploadBodyBytes + 1 } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(oversized, 413);
  const rpcHeaders = { ...headers, Accept: 'application/json, text/event-stream' };
  const initialized = await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: rpcHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'image-test', version: '1' } } }) });
  const mcpSession = initialized.headers.get('mcp-session-id')!; await initialized.arrayBuffer();
  const mcpLease = await open(env.core, mcpSession, 'image004');
  const mcpHeaders = { ...rpcHeaders, 'Mcp-Session-Id': mcpSession, 'MCP-Protocol-Version': '2025-06-18' };
  const paddedRpc = ' '.repeat(LIMITS.bodyBytes) + JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'figma.upload_image', arguments: { ...image, lease: mcpLease.lease } } });
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: paddedRpc })).status, 413);
  const rpc = await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'figma.upload_image', arguments: { ...JSON.parse(payload), lease: mcpLease.lease } } }) });
  assert.equal(rpc.status, 200); assert.equal((await rpc.json() as { result: { isError: boolean } }).result.isError, false);
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { extra: 'x'.repeat(LIMITS.bodyBytes) } }) })).status, 413);
  for (let i = 0; i < LIMITS.uploads; i++) {
    const req = request(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', agent: false, headers: { ...headers, 'Content-Length': LIMITS.bodyBytes + 1, Expect: '100-continue' } });
    req.on('error', () => undefined); pending.push(req);
    await new Promise<void>(resolve => { req.once('continue', resolve); req.flushHeaders(); });
    req.write('{');
  }
  await tick(); await tick();
  assert.equal((await fetch(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers, body: payload })).status, 429);
  assert.equal((await fetch(`${daemon.url}/api/status`, { headers })).status, 200);
  for (const req of pending) req.destroy(); await tick(); await tick();
  assert.equal((await fetch(`${daemon.url}/api/tools/figma.upload_image`, { method: 'POST', headers, body: payload })).status, 200);
});

const fixture = `<!doctype html><div role="toolbar"><button>Frame</button></div><canvas></canvas>
<button onclick="document.querySelector('input').click()">Upload image</button><button id="never">No chooser</button>
<input type="file" hidden accept="image/png,image/jpeg"><img id="preview" width="32" height="32"><div role="treeitem" id="layer"></div><div role="status">Saving…</div>
<script>window.clicked=false;document.getElementById('never').onclick=()=>window.clicked=true;
document.querySelector('input').onchange=async e=>{const file=e.target.files[0],data=await file.arrayBuffer();
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(x=>x.toString(16).padStart(2,'0')).join('');
const img=document.getElementById('preview');img.src=URL.createObjectURL(file);await img.decode();
window.upload={name:file.name,type:file.type,size:file.size,hash,width:img.naturalWidth,height:img.naturalHeight};document.getElementById('layer').textContent=file.name;document.querySelector('[role=status]').textContent='All changes saved';};</script>`;

for (const headed of [false, true]) test(`real file chooser receives PNG/JPEG byte hashes and replaces fixture image (${headed ? 'headed' : 'headless'})`, { timeout: 60_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_BROWSER || (headed && !process.env.FIGMA_SERVER_TEST_HEADED)) { t.skip('Enable sandboxed fixture browser and isolated headed display.'); return; }
  const env = await editorFixture(fixture, headed); t.after(env.cleanup);
  const session = env.core.sessions.createSession(), lease = await open(env.core, session);
  const page = env.context().pages().find(page => page.url().includes('/design/'))!;
  if (headed) await page.bringToFront(); // Only the isolated Xvfb fixture display.
  const [png, jpeg] = (await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 15;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 20, 15);
    return [canvas.toDataURL('image/png').split(',')[1]!, canvas.toDataURL('image/jpeg').split(',')[1]!];
  })).map(value => Buffer.from(value, 'base64'));
  const noise = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(512, 512);
    let seed = 1; for (let i = 0; i < pixels.data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24; }
    ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1]!;
  }), 'base64');
  assert.ok(noise.length > LIMITS.bodyBytes);
  const listeners = chooserListeners(page);
  for (const [filename, bytes, mime, width, height] of [ ['placed.png', png!, 'image/png', 20, 15], ['replacement.jpg', jpeg!, 'image/jpeg', 20, 15], ['large.png', noise, 'image/png', 512, 512] ] as const) {
    const result = await env.core.call(session, 'figma.upload_image', { lease: lease.lease, filename, data_base64: bytes.toString('base64'), trigger }) as { status: string };
    assert.equal(result.status, 'unverified');
    await page.waitForFunction(name => (window as unknown as { upload?: { name: string } }).upload?.name === name, filename);
    const received = await page.evaluate(() => (window as unknown as { upload: object }).upload);
    assert.deepEqual(received, { name: filename, type: mime, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), width, height });
    assert.equal(chooserListeners(page), listeners);
  }
  assert.equal((await env.core.call(session, 'figma.verify', { lease: lease.lease, expectation: { locator: { by: 'role', role: 'treeitem', name: 'large.png' }, saved: true } }) as { status: string }).status, 'verified');
});

test('upload timeout and cancellation remove file-chooser listeners and close before unlock', { timeout: 30_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_BROWSER) { t.skip('Enable isolated sandboxed fixture browser.'); return; }
  const env = await editorFixture(fixture); t.after(env.cleanup);
  const session = env.core.sessions.createSession();
  for (const cancel of [false, true]) {
    const lease = await open(env.core, session), page = env.context().pages().find(page => page.url().includes('/design/'))!;
    const abort = new AbortController();
    const pending = env.core.call(session, 'figma.upload_image', { ...image, lease: lease.lease, trigger: { by: 'role', role: 'button', name: 'No chooser' } }, abort.signal);
    await page.waitForFunction(() => (window as unknown as { clicked: boolean }).clicked);
    if (cancel) abort.abort();
    const result = await pending as { status: string; error?: { code: string } };
    assert.equal(result.status, cancel ? 'indeterminate' : 'failed');
    if (!cancel) assert.equal(result.error?.code, 'upload_timeout');
    assert.equal(page.isClosed(), true); assert.equal(chooserListeners(page), 0);
    assert.equal(env.core.sessions.leases.has(lease.lease), false);
  }
  assert.ok((await open(env.core, session)).lease);
});
