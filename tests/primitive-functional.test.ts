import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'playwright';
import { serve } from '../src/main.js';
import { LIMITS } from '../src/security.js';
import { editorFixture } from './helpers.js';

// These pages are intercepted fixtures, never authenticated Figma pages.
const fixture = `<!doctype html><div role="toolbar"><button>Frame</button></div>
<button id="upload" onclick="document.getElementById('file').click()">Upload image</button>
<button id="wait" onclick="window.waiting=true">No chooser</button><button>Selection marker</button>
<input id="file" type="file" hidden><canvas width="600" height="400"></canvas>
<input aria-label="Delivered image"><div role="status">All changes saved</div>
<script>
window.deliveries=[];window.waiting=false;
document.getElementById('file').onchange=async event=>{
 const file=event.target.files[0],bytes=await file.arrayBuffer();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const bitmap=await createImageBitmap(file);
 window.deliveries.push({name:file.name,type:file.type,size:file.size,hash,width:bitmap.width,height:bitmap.height});
 bitmap.close();document.querySelector('[aria-label="Delivered image"]').value=file.name;
};
for(const type of ['keydown','keyup','mousedown','mouseup','mousemove'])document.addEventListener(type,event=>{
 console.log('fixture-input:'+JSON.stringify({type,key:event.key,shift:event.shiftKey,alt:event.altKey,control:event.ctrlKey,meta:event.metaKey,buttons:event.buttons}));
});
</script>`;
const trigger = { by: 'role', role: 'button', name: 'Upload image' } as const;
type Receipt = { status: string; jobId: string };
type InputEvent = { type: string; key?: string; shift: boolean; alt: boolean; control: boolean; meta: boolean; buttons?: number };

async function publicFixture(t: TestContext) {
  const env = await editorFixture(fixture);
  const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  const transport = new StreamableHTTPClientTransport(new URL(daemon.url + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'independent-primitive-fixture', version: '1' });
  t.after(async () => {
    try { await transport.terminateSession(); } catch { /* Fixture teardown still closes core. */ }
    try { await client.close(); } finally { try { await daemon.close(); } finally { await env.cleanup(); } }
  });
  await client.connect(transport);
  async function json(path: string, body: object, session?: string, signal?: AbortSignal) {
    const response = await fetch(daemon.url + path, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(session ? { 'X-Figma-Session': session } : {}) }, body: JSON.stringify(body), signal,
    });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  }
  const a = (await json('/api/sessions', {})).session as string;
  const first = await json('/api/tools/figma.open', { file_url: 'https://www.figma.com/design/PrimitiveAlpha01', mode: 'write' }, a);
  async function mcp(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return JSON.parse(content.find(item => item.type === 'text')!.text!) as Record<string, unknown>;
  }
  const second = await mcp('figma.open', { file_url: 'https://www.figma.com/design/PrimitiveBeta02', mode: 'write' });
  const pages = env.context().pages();
  const pageA = pages.find(page => page.url().includes('PrimitiveAlpha01'))!;
  const pageB = pages.find(page => page.url().includes('PrimitiveBeta02'))!;
  return { ...env, pageA, pageB, first: first.lease as string, second: second.lease as string,
    api: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => json('/api/tools/' + name, { lease: first.lease, ...args }, a, signal),
    mcp: (name: string, args: Record<string, unknown>) => mcp(name, { lease: second.lease, ...args }) };
}

function browserEnabled(t: TestContext): boolean {
  if (process.env.FIGMA_SERVER_TEST_BROWSER) return true;
  t.skip('Set FIGMA_SERVER_TEST_BROWSER for isolated real-browser public-path qualification.');
  return false;
}

async function images(page: Page): Promise<[Buffer, Buffer]> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 4096; canvas.height = 2160;
    const ctx = canvas.getContext('2d')!, noise = ctx.createImageData(256, 256);
    let seed = 3;
    for (let i = 0; i < noise.data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0; noise.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    ctx.putImageData(noise, 0, 0);
    const png = canvas.toDataURL('image/png').split(',')[1]!;
    canvas.width = 20; canvas.height = 15;
    ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 20, 15);
    return [png, canvas.toDataURL('image/jpeg').split(',')[1]!] as const;
  });
  return [Buffer.from(encoded[0], 'base64'), Buffer.from(encoded[1], 'base64')];
}

async function delivery(page: Page, count: number) {
  await page.waitForFunction(n => (window as unknown as { deliveries: object[] }).deliveries.length === n, count);
  return page.evaluate(n => (window as unknown as { deliveries: object[] }).deliveries[n - 1], count);
}

test('public JSON/MCP concurrent choosers deliver distinct real image bytes; cancelled owner cannot affect another writer', { timeout: 60_000 }, async t => {
  if (!browserEnabled(t)) return;
  const env = await publicFixture(t), [png, jpeg] = await images(env.pageA);
  assert.ok(png.length > LIMITS.bodyBytes && png.length < LIMITS.imageBytes);
  const [a, b] = await Promise.all([
    env.api('figma.upload_image', { filename: 'alpha-4k.png', data_base64: png.toString('base64'), trigger }),
    env.mcp('figma.upload_image', { filename: 'beta.jpg', data_base64: jpeg.toString('base64'), trigger }),
  ]);
  assert.equal(a.status, 'unverified'); assert.equal(b.status, 'unverified');
  for (const [page, bytes, name, type, width, height] of [
    [env.pageA, png, 'alpha-4k.png', 'image/png', 4096, 2160],
    [env.pageB, jpeg, 'beta.jpg', 'image/jpeg', 20, 15],
  ] as const) {
    assert.deepEqual(await delivery(page, 1), { name, type, size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'), width, height });
  }
  const persisted = await readFile(env.state.path('artifacts', a.jobId as string, 'receipt.json'), 'utf8');
  assert.equal(persisted.includes(png.toString('base64')), false);
  assert.equal(persisted.includes('data_base64'), false);
  const abort = new AbortController();
  const pending = env.api('figma.upload_image', { filename: 'cancelled.png', data_base64: png.toString('base64'),
    trigger: { by: 'role', role: 'button', name: 'No chooser' } }, abort.signal).catch(() => undefined);
  await env.pageA.waitForFunction(() => (window as unknown as { waiting: boolean }).waiting);
  assert.equal((await env.mcp('figma.upload_image', { filename: 'beta-replacement.jpg', data_base64: jpeg.toString('base64'), trigger })).status, 'unverified');
  const closed = env.pageA.waitForEvent('close'); abort.abort(); await pending; await closed;
  assert.equal((env.pageA as unknown as { listenerCount(name: string): number }).listenerCount('filechooser'), 0);
  assert.equal(env.pageB.isClosed(), false);
  assert.equal((await env.mcp('figma.upload_image', { filename: 'beta-after-cancel.jpg', data_base64: jpeg.toString('base64'), trigger })).status, 'unverified');
  await delivery(env.pageB, 3);
  assert.equal((await env.mcp('figma.read_value', { locator: { by: 'role', role: 'textbox', name: 'Delivered image' } })).value, 'beta-after-cancel.jpg');
});

test('public modifier gestures remain target-local and release keys/buttons on a mid-drag failure', { timeout: 45_000 }, async t => {
  if (!browserEnabled(t)) return;
  const env = await publicFixture(t), eventsA: InputEvent[] = [], eventsB: InputEvent[] = [];
  for (const [page, events] of [[env.pageA, eventsA], [env.pageB, eventsB]] as const) {
    page.on('console', message => { if (message.text().startsWith('fixture-input:')) events.push(JSON.parse(message.text().slice(14)) as InputEvent); });
  }
  const marker = { by: 'role', role: 'button', name: 'Selection marker' } as const;
  assert.equal((await env.api('figma.click', { locator: marker, modifiers: ['Shift', 'Alt'] })).status, 'unverified');
  assert.ok(eventsA.some(event => event.type === 'mousedown' && event.shift && event.alt));
  await env.api('figma.pointer_click', { point: { x: 300, y: 200 } });
  assert.ok(eventsA.filter(event => event.type === 'mousedown').at(-1));
  assert.equal(eventsA.filter(event => event.type === 'mousedown').at(-1)!.shift, false);
  assert.equal(eventsA.filter(event => event.type === 'mousedown').at(-1)!.alt, false);
  let entered!: () => void, release!: () => void;
  const moving = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = env.pageA.mouse.move.bind(env.pageA.mouse);
  env.pageA.mouse.move = async (x, y, options) => {
    if (options?.steps === 10) { entered(); await gate; throw new Error('Controlled fixture mid-drag failure'); }
    return original(x, y, options);
  };
  t.after(() => { release(); });
  const failed = env.api('figma.drag', { from: { x: 300, y: 200 }, to: { x: 400, y: 260 }, modifiers: ['Shift', 'Alt'] });
  await moving;
  try {
    assert.equal((await env.mcp('figma.pointer_click', { point: { x: 300, y: 200 } })).status, 'unverified');
    const plain = eventsB.filter(event => event.type === 'mousedown').at(-1)!;
    assert.ok(plain); assert.equal(plain.shift || plain.alt || plain.control || plain.meta, false);
  } finally { release(); }
  const result = await failed as unknown as Receipt;
  assert.equal(result.status, 'failed'); assert.equal(env.pageA.isClosed(), true);
  assert.ok(eventsA.some(event => event.type === 'mouseup' && event.buttons === 0 && event.shift && event.alt));
  assert.ok(eventsA.some(event => event.type === 'keyup' && event.key === 'Alt'));
  assert.ok(eventsA.some(event => event.type === 'keyup' && event.key === 'Shift' && !event.shift && !event.alt));
  assert.equal((await env.mcp('figma.click', { locator: marker })).status, 'unverified');
  assert.equal(env.pageB.isClosed(), false);
});
