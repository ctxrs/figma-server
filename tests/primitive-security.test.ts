import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { crc32 } from 'node:zlib';
import type { BrowserContext, Page } from 'playwright';
import { PlaywrightTab } from '../src/browser-supervisor.js';
import { serve } from '../src/main.js';
import { LIMITS } from '../src/security.js';
import { DAEMON_URL, stdioProxy } from '../src/proxy.js';
import { PNG, editorFixture, open, setup, tick } from './helpers.js';

const trigger = { by: 'role', role: 'button', name: 'Upload image' } as const;
const image = { filename: 'image.png', data_base64: PNG.toString('base64'), trigger };
function largeImage() {
  const data = Buffer.from('review\0' + 'x'.repeat(160 * 1024)), tag = Buffer.from('tEXt');
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return { ...image, data_base64: Buffer.concat([PNG.subarray(0, -12), length, tag, data, checksum, PNG.subarray(-12)]).toString('base64') };
}
function rpcValue(reply: Reply) {
  assert.equal(reply.status, 200);
  const body = reply.json() as { result: { isError: boolean; content: { type: string; text?: string }[] } };
  const content = body.result.content.find(part => part.type === 'text');
  assert.ok(content?.text);
  return { isError: body.result.isError, value: JSON.parse(content.text) as Record<string, unknown> };
}
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'primitive-security', version: '1' },
} };
type Reply = { status: number; headers: IncomingHttpHeaders; bytes: Buffer; json(): Record<string, unknown> };

async function service(t: TestContext) {
  const env = await setup(), token = await env.state.secret();
  const http = await serve(env.core, { port: 0, token, accounts: ['default', 'other'] });
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const release of releases) release();
    try { await http.close(); } finally { await env.cleanup(); }
  });
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  }
  function start(path: string, data?: unknown, headers: Record<string, string> = {}, finish = true) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request(http.url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }), ...headers,
    } });
    const response = new Promise<Reply>((resolve, reject) => {
      req.once('error', reject);
      req.once('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.once('error', reject);
        res.once('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes,
            json: () => JSON.parse(bytes.toString()) as Record<string, unknown> });
        });
      });
    });
    if (finish) req.end(body); else req.flushHeaders();
    return { req, response };
  }
  const send = (path: string, data?: unknown, headers?: Record<string, string>) => start(path, data, headers).response;
  async function mcp() {
    const reply = await send('/mcp', initialize);
    assert.equal(reply.status, 200);
    const id = String(reply.headers['mcp-session-id']);
    const headers = { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': initialize.params.protocolVersion };
    assert.equal((await send('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status, 202);
    return { id, headers };
  }
  return { ...env, http, token, gate, start, send, mcp };
}

for (const attack of ['giant_id', 'unknown_envelope_field', 'giant_metadata'] as const) {
  test(`primitive security: large MCP allowance cannot be borrowed by ${attack}`, { timeout: 10_000 }, async t => {
    const env = await service(t), owner = await env.mcp();
    const lease = await open(env.core, owner.id);
    const tab = env.browser.tabs[0]!;
    let effects = 0;
    tab.screenshot = async () => { effects++; return PNG; };
    tab.uploadImage = async () => { effects++; };
    const padding = 'x'.repeat(LIMITS.bodyBytes + 1);
    const payload = { jsonrpc: '2.0', id: attack === 'giant_id' ? padding : 2, method: 'tools/call',
      params: { name: 'figma.upload_image', arguments: { ...image, lease: lease.lease },
        ...(attack === 'giant_metadata' ? { _meta: { padding } } : {}) },
      ...(attack === 'unknown_envelope_field' ? { padding } : {}) };
    const reply = await env.send('/mcp', payload, owner.headers);
    assert.equal(effects, 0);
    if (attack === 'unknown_envelope_field') assert.ok([400, 413].includes(reply.status));
    else assert.equal(reply.status, 413, 'Extra large frames must be justified by supplied image bytes, not envelope padding.');
    assert.deepEqual(await readdir(env.state.path('artifacts')), []);
    assert.equal(reply.bytes.includes(image.data_base64), false);
  });
}

test('primitive security: auth and session checks reject a large upload before waiting for its body', { timeout: 10_000 }, async t => {
  const env = await service(t), owner = await env.mcp();
  for (const [path, headers, expected] of [
    ['/api/tools/figma.upload_image', { Authorization: 'Bearer wrong' }, 401],
    ['/mcp', { ...owner.headers, Authorization: 'Bearer wrong' }, 401],
    ['/api/tools/figma.upload_image', { 'X-Figma-Session': 'not-a-session' }, 404],
    ['/mcp', { 'Mcp-Session-Id': 'not-a-session' }, 404],
  ] as const) {
    const call = env.start(path, {}, { ...headers, 'Content-Length': String(LIMITS.uploadBodyBytes) }, false);
    try { assert.equal((await call.response).status, expected); } finally { call.req.destroy(); }
  }
  assert.equal(env.browser.tabs.length, 0);
  assert.equal((await env.send('/api/status')).status, 200);
});

test('primitive security: modifier aliases are released before a queued bare key, including mouse failure', { timeout: 10_000 }, async t => {
  const env = await service(t), owner = env.core.sessions.createSession();
  for (const fail of [false, true]) {
    const lease = await open(env.core, owner, fail ? 'failure001' : 'success001');
    const tab = env.browser.tabs.at(-1)!;
    const entered = env.gate(), finish = env.gate();
    const held = new Set<string>(), events: string[] = [];
    let clipboard = false;
    const page = {
      keyboard: {
        down: async (key: string) => { events.push('down:' + key); held.add(key); },
        up: async (key: string) => { events.push('up:' + key); held.delete(key); },
        press: async (key: string) => { clipboard ||= (held.has('Control') || held.has('Meta')) && key === 'KeyC'; events.push('key:' + key); },
      },
      mouse: { click: async () => { events.push('mouse'); entered.resolve(); await finish.promise; if (fail) throw new Error('synthetic mouse failure'); } },
      isClosed: () => tab.closed,
    };
    const adapter = new PlaywrightTab(page as unknown as Page, {} as BrowserContext, lease.fileKey, tab.generation, () => !tab.closed);
    tab.pointerClick = adapter.pointerClick.bind(adapter);
    tab.keypress = adapter.keypress.bind(adapter);
    const headers = { 'X-Figma-Session': owner };
    const rejected = await env.send('/api/tools/figma.keypress', { lease: lease.lease, keys: 'ControlOrMeta+KeyC' }, headers);
    assert.equal(rejected.status, 400);
    assert.equal((rejected.json().error as { code: string }).code, 'shared_clipboard');
    const mouse = env.send('/api/tools/figma.pointer_click', { lease: lease.lease, point: { x: 100, y: 100 }, modifiers: ['Control', 'ControlOrMeta'] }, headers);
    await entered.promise;
    const jobs = (await readdir(env.state.path('artifacts'))).length;
    const key = env.send('/api/tools/figma.keypress', { lease: lease.lease, keys: 'KeyC' }, headers);
    for (let tries = 0; tries < 100 && (await readdir(env.state.path('artifacts'))).length === jobs; tries++) await tick();
    assert.ok((await readdir(env.state.path('artifacts'))).length > jobs, 'The bare key must be queued while modifiers are held.');
    finish.resolve();
    const [mouseReply, keyReply] = await Promise.all([mouse, key]);
    assert.equal(mouseReply.json().status, fail ? 'failed' : 'unverified');
    assert.equal(held.size, 0);
    assert.equal(clipboard, false);
    const physical = process.platform === 'darwin' ? ['Control', 'Meta'] : ['Control'];
    assert.deepEqual(events, [...physical.map(name => 'down:' + name), 'mouse', ...physical.reverse().map(name => 'up:' + name), ...(fail ? [] : ['key:KeyC'])]);
    if (fail) assert.equal(keyReply.json().status, 'failed');
    else assert.equal(keyReply.json().status, 'unverified');
  }
});

const chooserFixture = `<!doctype html><div role="toolbar"><button>Frame</button></div><canvas></canvas>
<button onclick="window.waiting=true">Wait chooser</button>
<button onclick="document.querySelector('input').click()">Upload image</button><input type="file" hidden>
<script>document.querySelector('input').onchange=e=>window.received=e.target.files[0].name;</script>`;

test('primitive security: cancellation and another page chooser cannot cross upload leases', { timeout: 30_000 }, async t => {
  if (!process.env.FIGMA_SERVER_TEST_BROWSER) { t.skip('Enable the isolated sandboxed fixture browser.'); return; }
  const env = await editorFixture(chooserFixture);
  t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession();
  const first = await open(env.core, a, 'firstimage001'), second = await open(env.core, b, 'secondimage001');
  const firstPage = env.context().pages().find(page => page.url().includes(first.fileKey))!;
  const secondPage = env.context().pages().find(page => page.url().includes(second.fileKey))!;
  const abort = new AbortController();
  const waiting = env.core.call(a, 'figma.upload_image', { ...image, filename: 'first.png', lease: first.lease,
    trigger: { by: 'role', role: 'button', name: 'Wait chooser' } }, abort.signal);
  await firstPage.waitForFunction(() => (window as unknown as { waiting?: boolean }).waiting);
  const other = await env.core.call(b, 'figma.upload_image', { ...image, filename: 'second.png', lease: second.lease }) as { status: string };
  assert.equal(other.status, 'unverified');
  assert.equal(await firstPage.evaluate(() => (window as unknown as { received?: string }).received), undefined);
  assert.equal(await secondPage.evaluate(() => (window as unknown as { received?: string }).received), 'second.png');
  abort.abort();
  assert.equal((await waiting as { status: string }).status, 'indeterminate');
  assert.equal(firstPage.isClosed(), true);
  assert.equal((firstPage as unknown as { listenerCount(event: string): number }).listenerCount('filechooser'), 0);
  assert.equal(secondPage.isClosed(), false);
  assert.equal(env.core.sessions.leases.has(first.lease), false);
  await env.core.call(b, 'figma.inspect', { lease: second.lease });
});

test('primitive security: large image upload completes after MCP socket loss and the session reconnects without bytes in receipts', { timeout: 10_000 }, async t => {
  const env = await service(t), owner = await env.mcp(), lease = await open(env.core, owner.id);
  const tab = env.browser.tabs[0]!;
  const entered = env.gate(), finish = env.gate(), settled = env.gate();
  const supplied = largeImage();
  let dispatched = 0;
  tab.uploadImage = async (_image, _trigger, signal) => {
    try { entered.resolve(); await finish.promise; signal?.throwIfAborted(); await tab.check(); dispatched++; }
    finally { settled.resolve(); }
  };
  const call = env.start('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'figma.upload_image', arguments: { ...supplied, lease: lease.lease } } }, owner.headers);
  void call.response.catch(() => undefined);
  await entered.promise;
  call.req.destroy();
  finish.resolve();
  await settled.promise;
  const inspection = rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'figma.inspect', arguments: { lease: lease.lease } } }, owner.headers));
  assert.equal(inspection.isError, false);
  assert.equal(tab.closed, false);
  assert.equal(dispatched, 1);
  for (const job of await readdir(env.state.path('artifacts'))) {
    let receipt: string | undefined;
    for (let tries = 0; tries < 100 && receipt === undefined; tries++) {
      try { receipt = await readFile(env.state.path('artifacts', job, 'receipt.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await tick(); }
    }
    assert.ok(receipt, 'The completed upload must finish its receipt.');
    assert.equal(receipt.includes(supplied.data_base64), false);
    assert.equal(receipt.includes('data_base64'), false);
    assert.equal(receipt.includes(env.token), false);
  }
});

test('primitive security: cancelled quarantined MCP upload keeps its memory slot until browser work actually settles', { timeout: 10_000 }, async t => {
  const env = await service(t), owner = await env.mcp();
  const leases = await Promise.all(['uploadfirst001', 'uploadsecond001', 'uploadthird001'].map(key => open(env.core, owner.id, key)));
  const supplied = largeImage(), first = env.gate(), second = env.gate(), finishFirst = env.gate(), finishSecond = env.gate(), settled = env.gate();
  env.browser.tabs[0]!.failClose = true;
  env.browser.tabs[0]!.uploadImage = async (_image, _trigger, signal) => {
    try { first.resolve(); await finishFirst.promise; signal?.throwIfAborted(); }
    finally { settled.resolve(); }
  };
  env.browser.tabs[1]!.uploadImage = async () => { second.resolve(); await finishSecond.promise; };
  const upload = (index: number, id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'figma.upload_image', arguments: { ...supplied, lease: leases[index]!.lease } } });
  const a = env.start('/mcp', upload(0, 2), owner.headers), b = env.start('/mcp', upload(1, 3), owner.headers);
  void a.response.catch(() => undefined); void b.response.catch(() => undefined);
  await Promise.all([first.promise, second.promise]);
  assert.equal((await env.send('/mcp', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }, owner.headers)).status, 202);
  const cancelled = await a.response;
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json().result, undefined);
  assert.equal(cancelled.bytes.includes(supplied.data_base64), false);
  assert.equal(env.core.sessions.leases.get(leases[0]!.lease)?.quarantined, true);
  const capacity = rpcValue(await env.send('/mcp', upload(2, 4), owner.headers));
  assert.equal(capacity.isError, true);
  assert.equal(capacity.value.code, 'upload_limit');
  finishFirst.resolve();
  await settled.promise;
  await tick();
  assert.equal(rpcValue(await env.send('/mcp', upload(2, 5), owner.headers)).isError, false);
  finishSecond.resolve();
  assert.equal(rpcValue(await b.response).isError, false);
  assert.equal((await env.send('/api/status')).status, 200);
});

test('primitive security: JPEG without any scan is rejected before screenshot or chooser effects', { timeout: 10_000 }, async t => {
  const env = await service(t), owner = env.core.sessions.createSession(), lease = await open(env.core, owner);
  const tab = env.browser.tabs[0]!;
  let effects = 0;
  tab.screenshot = async () => { effects++; return PNG; };
  tab.uploadImage = async () => { effects++; };
  // SOI + valid-looking 1x1 baseline SOF + EOI, with no scan header or image data.
  const noScan = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex');
  const reply = await env.send('/api/tools/figma.upload_image', { ...image, filename: 'no-scan.jpg',
    data_base64: noScan.toString('base64'), lease: lease.lease }, { 'X-Figma-Session': owner });
  assert.equal(reply.status, 400);
  assert.equal(effects, 0);
  assert.equal((reply.json().error as { code: string }).code, 'invalid_image');
});

test('primitive security: stdio ordinary calls and cancellation bypass two occupied large-frame slots', { timeout: 10_000 }, async t => {
  const env = await service(t), input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const nativeFetch = globalThis.fetch;
  // Keep the production proxy and HTTP service; route its fixed daemon address
  // to an ephemeral test port so this test cannot touch a running daemon.
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin, DAEMON_URL);
    assert.equal(endpoint.pathname, '/mcp');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${env.token}`);
    return nativeFetch(env.http.url + '/mcp', init);
  });
  const replies = new Map<number, Record<string, unknown>>();
  let buffered = '', diagnosticText = '';
  output.on('data', chunk => {
    buffered += String(chunk);
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      buffered = buffered.slice(newline + 1);
      if (typeof message.id === 'number') replies.set(message.id, message);
    }
  });
  diagnostics.on('data', chunk => { diagnosticText += String(chunk); });
  async function until(predicate: () => boolean, description: string) {
    for (let tries = 0; tries < 300 && !predicate(); tries++) await tick();
    assert.ok(predicate(), description);
  }
  async function reply(id: number) {
    await until(() => replies.has(id), `MCP response ${id} must arrive without releasing the upload gates.`);
    return replies.get(id)!;
  }
  const write = (message: unknown) => input.write(JSON.stringify(message) + '\n');
  const ready = once(input, 'resume');
  const running = stdioProxy(env.state, { stdin: input, stdout: output, stderr: diagnostics });
  void running.catch(() => undefined);
  const finish = env.gate();
  try {
    await ready;
    write(initialize);
    assert.ok((await reply(1)).result);
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const owner = env.core.sessions.sessions.keys().next().value!;
    const leases = await Promise.all(['stdiofirst001', 'stdiosecond001', 'stdiothird001'].map(key => open(env.core, owner, key)));
    let entered = 0;
    for (const tab of env.browser.tabs.slice(0, 2)) {
      tab.uploadImage = async (_payload, _trigger, signal) => {
        entered++;
        await finish.promise;
        signal?.throwIfAborted();
        await tab.check();
      };
    }
    const supplied = largeImage();
    const upload = (index: number, id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'figma.upload_image', arguments: { ...supplied, lease: leases[index]!.lease } } });
    assert.ok(Buffer.byteLength(JSON.stringify(upload(0, 2))) > LIMITS.bodyBytes);
    // One input chunk exercises framing as well as simultaneous reservations.
    input.write(JSON.stringify(upload(0, 2)) + '\n' + JSON.stringify(upload(1, 3)) + '\n');
    await until(() => entered === 2, 'Both large uploads must reach their owned backend pages.');
    write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'figma.account_status', arguments: {} } });
    assert.ok((await reply(4)).result, 'Ordinary calls must bypass the two occupied large-frame slots.');
    assert.equal(replies.has(2), false);
    assert.equal(replies.has(3), false);
    write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    assert.ok((await reply(2)).error, 'Explicit cancellation must retire its HTTP response without waiting for browser work.');
    assert.equal(env.browser.tabs[0]!.closed, true);
    assert.equal(env.browser.tabs[1]!.closed, false);
    // The transport slot is now free, while the browser's separate memory
    // budget correctly still contains both unresolved upload operations.
    write(upload(2, 5));
    const capacity = (await reply(5)).result as { isError: boolean; content: { text: string }[] };
    assert.equal(capacity.isError, true);
    assert.equal(JSON.parse(capacity.content[0]!.text).code, 'upload_limit');
    finish.resolve();
    assert.ok((await reply(3)).result);
  } finally {
    finish.resolve();
    input.end();
    await running;
  }
  await until(() => env.core.sessions.sessions.size === 0 && env.core.sessions.leases.size === 0, 'EOF must close the logical session and its leases.');
  assert.equal(diagnosticText, '');
});
