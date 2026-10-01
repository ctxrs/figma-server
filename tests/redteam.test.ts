import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright';
import { browserEnvironment } from '../src/browser-supervisor.js';
import { pasteHtml } from '../src/figma-adapter.js';
import { LIMITS } from '../src/security.js';
import { serve } from '../src/main.js';
import type { Receipt } from '../src/receipts.js';
import { setup } from './helpers.js';

type Reply = { status: number; headers: IncomingHttpHeaders; bytes: Buffer; json(): Record<string, unknown> };
type RpcReply = { result?: { content: { type: string; text?: string }[]; isError?: boolean }; error?: unknown };
const file = 'https://www.figma.com/design/RedTeamFile01';
const locator = { by: 'label', name: 'Description' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'redteam-fixture', version: '1' },
} };

// All browser gates are released during cleanup, including after a failed assertion.
async function service(t: TestContext) {
  const env = await setup();
  const token = await env.state.secret();
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
  function start(path: string, data?: unknown, headers: Record<string, string | undefined> = {}, method = data === undefined ? 'GET' : 'POST') {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const outgoing: Record<string, string | undefined> = {
      Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }),
      ...headers,
    };
    for (const key of Object.keys(outgoing)) if (outgoing[key] === undefined) delete outgoing[key];
    // Use node:http: fetch implementations can rewrite a supplied Host header.
    const req = request(http.url + path, { method, headers: outgoing });
    const response = new Promise<Reply>((resolve, reject) => {
      req.once('error', reject);
      req.once('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
        res.once('error', reject);
        res.once('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes,
            json: () => JSON.parse(bytes.toString('utf8')) as Record<string, unknown> });
        });
      });
    });
    req.end(body);
    return { req, response };
  }
  const send = (path: string, data?: unknown, headers?: Record<string, string | undefined>, method?: string) => start(path, data, headers, method).response;
  async function session() {
    const created = await send('/api/sessions', {});
    assert.equal(created.status, 201);
    return String(created.json().session);
  }
  const tool = (session: string, name: string, args: unknown) => send(`/api/tools/${name}`, args, { 'X-Figma-Session': session });
  async function open(session: string, url = file) {
    const reply = await tool(session, 'figma.open', { file_url: url });
    assert.equal(reply.status, 200, reply.bytes.toString());
    return String(reply.json().lease);
  }
  async function mcp() {
    const reply = await send('/mcp', initialize);
    assert.equal(reply.status, 200, reply.bytes.toString());
    const id = reply.headers['mcp-session-id'];
    assert.equal(typeof id, 'string');
    const headers = { 'Mcp-Session-Id': String(id), 'MCP-Protocol-Version': initialize.params.protocolVersion };
    assert.equal((await send('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status, 202);
    return { id: String(id), headers };
  }
  return { ...env, token, http, gate, start, send, session, tool, open, mcp };
}

function rpcValue(reply: Reply): Record<string, unknown> {
  assert.equal(reply.status, 200, reply.bytes.toString());
  const result = reply.json() as RpcReply;
  assert.equal(result.error, undefined);
  assert.equal(result.result?.isError, false, reply.bytes.toString());
  const content = result.result?.content.find(part => part.type === 'text');
  assert.ok(content?.text);
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function eventually(check: () => boolean, message: string) {
  const until = Date.now() + 2000;
  while (!check() && Date.now() < until) await delay(5);
  assert.ok(check(), message);
}

test('redteam: actual HTTP and MCP reject hostile auth, Origin and raw Host before creating sessions', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const attacks: [Record<string, string | undefined>, number, string][] = [
    [{ Authorization: undefined }, 401, 'unauthorized'],
    [{ Authorization: 'Bearer ' + 'b'.repeat(64) }, 401, 'unauthorized'],
    [{ Origin: 'null' }, 403, 'origin_denied'],
    [{ Origin: env.http.url + '.attacker.invalid' }, 403, 'origin_denied'],
    [{ Host: 'attacker.invalid' }, 403, 'host_denied'],
    [{ Host: 'localhost:' + new URL(env.http.url).port }, 403, 'host_denied'],
  ];
  for (const [headers, status, code] of attacks) {
    for (const path of ['/api/sessions', '/mcp']) {
      const reply = await env.send(path, path === '/mcp' ? initialize : {}, headers);
      assert.equal(reply.status, status, `${path}: ${JSON.stringify(headers)}`);
      assert.equal((reply.json().error as { code: string }).code, code);
      assert.equal(reply.bytes.includes(env.token), false);
    }
  }
  assert.equal(env.core.sessions.sessions.size, 0);
  assert.equal(env.browser.tabs.length, 0);
  assert.equal((await env.send('/api/status', undefined, { Origin: env.http.url })).status, 200);
});

test('redteam: URL normalization prevents hostile file/IP URLs from reaching the browser and strips query secrets', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  const opened: string[] = [];
  const original = env.browser.open.bind(env.browser);
  env.browser.open = async (account, url, key) => { opened.push(url); return original(account, url, key); };
  for (const url of ['https://[::1]/design/RedTeamFile01', 'https://[fe80::1]/design/RedTeamFile01',
    'https://2130706433/design/RedTeamFile01', 'https://www.figma.com.attacker.invalid/design/RedTeamFile01',
    'https://www.figma.com@attacker.invalid/design/RedTeamFile01']) {
    const reply = await env.tool(owner, 'figma.open', { file_url: url });
    assert.equal(reply.status, 400, url);
  }
  assert.deepEqual(opened, []);
  await env.open(owner, file + '/name?node-id=1-2&access_token=synthetic-query-secret#synthetic-fragment');
  assert.deepEqual(opened, [file + '?node-id=1-2']);
});

test('redteam: hostile HTML is rejected before screenshot, paste or lease invalidation', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  for (const html of ['<video poster="https://attacker.invalid/pixel"></video>',
    '<div style="background:u\\72l(https://attacker.invalid/pixel)">x</div>',
    '<div style=\'background-image:image-set("https://attacker.invalid/pixel" 1x)\'>x</div>']) {
    const lease = await env.open(owner);
    const tab = env.browser.tabs.at(-1)!;
    let screenshots = 0;
    const screenshot = tab.screenshot.bind(tab);
    tab.screenshot = async () => { screenshots++; return screenshot(); };
    const reply = await env.tool(owner, 'figma.paste_html', { lease, html });
    // An invalid payload must not enter the browser execution/receipt path.
    assert.equal(screenshots, 0, html);
    assert.deepEqual(tab.operations, [], html);
    assert.equal(tab.closed, false, html);
    assert.equal(reply.status, 400, reply.bytes.toString());
    assert.equal((reply.json().error as { code: string }).code, 'unsafe_html');
    assert.equal((await env.tool(owner, 'figma.inspect', { lease })).status, 200);
    await env.tool(owner, 'figma.release', { lease });
  }
});

test('redteam: raw browser errors and requested form text stay out of HTTP responses and persisted receipts', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  const lease = await env.open(owner);
  const tab = env.browser.tabs.at(-1)!;
  tab.fill = async () => { throw new Error('Cookie: sid=synthetic-cookie; csrf=synthetic-csrf\n{"password":"synthetic-password"}'); };
  const reply = await env.tool(owner, 'figma.fill', { lease, locator, text: 'synthetic-form-value' });
  assert.equal(reply.status, 200);
  const receipt = reply.json() as Receipt;
  assert.equal(receipt.status, 'failed');
  const persisted = await readFile(env.state.path('artifacts', receipt.jobId, 'receipt.json'), 'utf8');
  for (const secret of ['synthetic-cookie', 'synthetic-csrf', 'synthetic-password', 'synthetic-form-value', env.token]) {
    assert.equal(reply.bytes.includes(secret), false, secret);
    assert.equal(persisted.includes(secret), false, secret);
  }
});

test('redteam: action error plus failed closure reports indeterminate and retains the writer quarantine', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  const lease = await env.open(owner);
  const tab = env.browser.tabs.at(-1)!;
  tab.fill = async () => { throw new Error('synthetic selector failure after possible input'); };
  tab.failClose = true;
  const reply = await env.tool(owner, 'figma.fill', { lease, locator, text: 'x' });
  assert.equal(reply.status, 200);
  const receipt = reply.json() as Receipt;
  assert.equal(env.core.sessions.leases.get(lease)?.quarantined, true);
  await assert.rejects(env.core.sessions.files.acquire('RedTeamFile01', undefined, 15), { code: 'file_busy' });
  assert.equal(receipt.status, 'indeterminate');
  assert.equal(receipt.error?.code, 'indeterminate');
  assert.equal(receipt.verification, undefined);
});

test('redteam: MCP HTTP disconnect is not cancellation and the logical session can reconnect', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.mcp();
  const lease = String(rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'figma.open', arguments: { file_url: file } } }, owner.headers)).lease);
  const tab = env.browser.tabs.at(-1)!;
  const entered = env.gate(), finish = env.gate(), finished = env.gate();
  tab.fill = async () => { entered.resolve(); await finish.promise; await tab.check(); tab.operations.push('fill'); finished.resolve(); };
  const call = env.start('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'figma.fill', arguments: { lease, locator, text: 'gated' } } }, owner.headers);
  void call.response.catch(() => undefined);
  await entered.promise;
  call.req.destroy();
  await delay(20);
  assert.equal(tab.closed, false, 'A lost HTTP connection is not an MCP cancellation notification.');
  assert.equal(env.core.sessions.leases.get(lease)?.invalid, false);
  finish.resolve();
  await finished.promise;
  rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'figma.inspect', arguments: { lease } } }, owner.headers));
  assert.deepEqual(tab.operations, ['fill']);
});

test('redteam: explicit MCP cancellation closes before another writer enters', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.mcp();
  const lease = String(rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'figma.open', arguments: { file_url: file } } }, owner.headers)).lease);
  const tab = env.browser.tabs.at(-1)!;
  const entered = env.gate(), finish = env.gate(), closing = env.gate(), finishClose = env.gate();
  const originalClose = tab.close.bind(tab);
  tab.close = async () => { closing.resolve(); await finishClose.promise; await originalClose(); };
  tab.fill = async () => { entered.resolve(); await finish.promise; await tab.check(); tab.operations.push('fill'); };
  const call = env.start('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'figma.fill', arguments: { lease, locator, text: 'gated' } } }, owner.headers);
  void call.response.catch(() => undefined);
  await entered.promise;
  const cancel = await env.send('/mcp', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, owner.headers);
  assert.equal(cancel.status, 202);
  await closing.promise;
  const nextOwner = await env.session();
  let nextEntered = false;
  const next = env.open(nextOwner).then(id => { nextEntered = true; return id; });
  void next.catch(() => undefined);
  await delay(20);
  assert.equal(nextEntered, false, 'The old tab must be confirmed closed before transferring its file lock.');
  finishClose.resolve();
  const nextLease = await next;
  assert.equal(tab.closed, true);
  assert.equal(env.core.sessions.leases.has(lease), false);
  finish.resolve();
  call.req.destroy();
  assert.deepEqual(tab.operations, [], 'Cancelled browser input must not complete after closure.');
  assert.equal((await env.tool(nextOwner, 'figma.inspect', { lease: nextLease })).status, 200);
});

test('redteam: HTTP operation deadline returns indeterminate, closes the target and releases its writer lock', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  const lease = await env.open(owner);
  const tab = env.browser.tabs.at(-1)!;
  const entered = env.gate(), finish = env.gate();
  tab.fill = async () => { entered.resolve(); await finish.promise; await tab.check(); tab.operations.push('fill'); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = env.tool(owner, 'figma.fill', { lease, locator, text: 'gated' });
  await entered.promise;
  t.mock.timers.tick(30_001);
  const reply = await operation;
  t.mock.timers.reset();
  const receipt = reply.json() as Receipt;
  assert.equal(reply.status, 200);
  assert.equal(receipt.status, 'indeterminate');
  assert.equal(receipt.error?.code, 'indeterminate');
  assert.equal(receipt.verification, undefined);
  assert.equal(tab.closed, true);
  finish.resolve();
  const next = await env.open(owner);
  assert.deepEqual(tab.operations, []);
  assert.equal((await env.tool(owner, 'figma.inspect', { lease: next })).status, 200);
});

test('redteam: JSON HTTP disconnect cancels its active operation and preserves a closed target', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session();
  const lease = await env.open(owner);
  const tab = env.browser.tabs.at(-1)!;
  const entered = env.gate(), finish = env.gate();
  tab.fill = async () => { entered.resolve(); await finish.promise; await tab.check(); tab.operations.push('fill'); };
  const call = env.start('/api/tools/figma.fill', { lease, locator, text: 'gated' }, { 'X-Figma-Session': owner });
  void call.response.catch(() => undefined);
  await entered.promise;
  call.req.destroy();
  await eventually(() => tab.closed, 'JSON request disconnection must close the target.');
  assert.equal(env.core.sessions.leases.has(lease), false);
  finish.resolve();
  const next = await env.open(owner);
  assert.deepEqual(tab.operations, []);
  assert.equal((await env.tool(owner, 'figma.inspect', { lease: next })).status, 200);
});

test('redteam: leases and image artifacts cannot cross HTTP/MCP sessions or survive session deletion', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.mcp(), other = await env.session();
  const lease = String(rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'figma.open', arguments: { file_url: file } } }, owner.headers)).lease);
  assert.equal((await env.tool(other, 'figma.inspect', { lease })).status, 404);
  const shot = rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'figma.screenshot', arguments: { lease } } }, owner.headers));
  const artifact = String(shot.artifact);
  const endpoint = '/api/' + artifact;
  assert.equal((await env.send(endpoint, undefined, { 'X-Figma-Session': other })).status, 404);
  const owned = await env.send(endpoint, undefined, { 'X-Figma-Session': owner.id });
  assert.equal(owned.status, 200);
  assert.equal(owned.headers['content-type'], 'image/png');
  assert.equal(owned.headers['cache-control'], 'no-store');
  assert.equal((await env.send('/mcp', undefined, owner.headers, 'DELETE')).status, 200);
  await eventually(() => !env.core.sessions.sessions.has(owner.id), 'MCP DELETE must revoke its core session.');
  assert.equal((await env.send(endpoint, undefined, { 'X-Figma-Session': owner.id })).status, 404);
  assert.equal(env.browser.tabs[0]?.closed, true);
});

test('redteam: cancelled pending open keeps its lock through orphan quarantine until confirmed browser crash', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session(), nextOwner = await env.session();
  const entered = env.gate(), finish = env.gate();
  const originalOpen = env.browser.open.bind(env.browser);
  let first = true;
  env.browser.open = async (account, url, key) => {
    if (!first) return originalOpen(account, url, key);
    first = false;
    entered.resolve();
    await finish.promise;
    const tab = await originalOpen(account, url, key);
    env.browser.tabs.at(-1)!.failClose = true;
    return tab;
  };
  const pending = env.start('/api/tools/figma.open', { file_url: file }, { 'X-Figma-Session': owner });
  void pending.response.catch(() => undefined);
  await entered.promise;
  pending.req.destroy();
  let nextEntered = false;
  const next = env.open(nextOwner).then(id => { nextEntered = true; return id; });
  void next.catch(() => undefined);
  await delay(20);
  assert.equal(nextEntered, false, 'An abandoned browser-open promise must retain its writer reservation.');
  finish.resolve();
  await eventually(() => [...env.core.sessions.leases.values()].some(lease => lease.session === owner && lease.quarantined),
    'Cancelled open must track the target when closure fails.');
  const orphan = [...env.core.sessions.leases.values()].find(lease => lease.session === owner)!;
  assert.equal(orphan.invalid, true);
  assert.equal(orphan.tab, env.browser.tabs[0]);
  assert.equal(env.browser.tabs[0]!.closed, false);
  assert.equal(nextEntered, false);
  env.browser.crash();
  // Simulate a subsequently recovered account; crash has confirmed the old target dead.
  env.browser.states.set('default', { account: 'default', state: 'ready', generation: env.browser.generation });
  const nextLease = await next;
  assert.equal(env.core.sessions.leases.has(orphan.id), false);
  assert.equal(env.browser.tabs[0]!.closed, true);
  assert.equal((await env.tool(nextOwner, 'figma.inspect', { lease: nextLease })).status, 200);
});

test('redteam: late confirmed closure recovers quarantine without transferring the lock on timeout', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.session(), nextOwner = await env.session();
  const lease = await env.open(owner), tab = env.browser.tabs[0]!;
  const closing = env.gate(), finishClose = env.gate();
  const originalClose = tab.close.bind(tab);
  tab.close = async () => { closing.resolve(); await finishClose.promise; await originalClose(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = env.tool(owner, 'figma.release', { lease });
  await closing.promise;
  t.mock.timers.tick(5001);
  const reply = await release;
  t.mock.timers.reset();
  assert.equal(reply.status, 409);
  assert.equal((reply.json().error as { code: string }).code, 'indeterminate');
  assert.equal(env.core.sessions.leases.get(lease)?.quarantined, true);
  assert.equal(tab.closed, false);
  let nextEntered = false;
  const next = env.open(nextOwner).then(id => { nextEntered = true; return id; });
  void next.catch(() => undefined);
  await delay(20);
  assert.equal(nextEntered, false);
  finishClose.resolve();
  const nextLease = await next;
  assert.equal(tab.closed, true);
  assert.equal(env.core.sessions.leases.has(lease), false);
  assert.equal((await env.tool(nextOwner, 'figma.inspect', { lease: nextLease })).status, 200);
});

test('redteam: actual browser paste parses inert markup without payload network requests or execution', { timeout: 30_000 }, async t => {
  const env = await setup();
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  t.after(async () => { try { await context?.close(); } finally { await env.cleanup(); } });
  context = await chromium.launchPersistentContext(env.state.path('accounts', 'default', 'profile'), {
    executablePath: process.env.FIGMA_SERVER_TEST_BROWSER ?? chromium.executablePath(), channel: 'chromium',
    headless: true, chromiumSandbox: true, serviceWorkers: 'block', env: browserEnvironment(env.state),
  });
  const unexpected: string[] = [];
  await context.route('**/*', async route => {
    if (route.request().url() === file && route.request().isNavigationRequest()) {
      await route.fulfill({ contentType: 'text/html', body: `<link rel="icon" href="data:,"><div id="receiver" tabindex="0"></div><script>
        window.pastes=0; window.executed=0;
        receiver.addEventListener('paste',event=>{window.pastes++;receiver.innerHTML=event.clipboardData.getData('text/html')});
        receiver.focus();
      </script>` });
    } else { unexpected.push(route.request().url()); await route.abort('blockedbyclient'); }
  });
  const page = await context.newPage();
  await page.goto(file);
  for (const html of ['<p><strong>inert</strong> text</p>',
    '<p>&lt;img src="https://attacker.invalid/pixel"&gt;</p>',
    '<div>&#60;script&#62;window.executed++&#60;/script&#62;</div>']) await pasteHtml(page, html);
  for (const html of ['<video poster="https://attacker.invalid/pixel"></video>',
    '<div style="background:u\\72l(https://attacker.invalid/pixel)">x</div>',
    '<div style=\'background:image-set("https://attacker.invalid/pixel" 1x)\'>x</div>',
    '<svg><image href="http://127.0.0.1:9/pixel"/></svg>', '<script>window.executed++</script>']) {
    await assert.rejects(pasteHtml(page, html), { code: 'unsafe_html' });
  }
  await page.waitForTimeout(50);
  assert.deepEqual(unexpected, [], 'Paste must not even attempt an external or loopback request.');
  assert.deepEqual(await page.evaluate(() => ({
    pastes: (window as unknown as { pastes: number }).pastes,
    executed: (window as unknown as { executed: number }).executed,
    activeNodes: document.getElementById('receiver')!.querySelectorAll('img,video,svg,iframe,object,link,style,script').length,
  })), { pastes: 3, executed: 0, activeNodes: 0 });
});

test('redteam: repeated explicit MCP cancellation releases HTTP request capacity', { timeout: 10_000 }, async t => {
  const env = await service(t);
  const owner = await env.mcp();
  for (let index = 0; index <= LIMITS.queue; index++) {
    const openId = 10 + index * 2, inputId = openId + 1;
    const lease = String(rpcValue(await env.send('/mcp', { jsonrpc: '2.0', id: openId, method: 'tools/call',
      params: { name: 'figma.open', arguments: { file_url: file } } }, owner.headers)).lease);
    const tab = env.browser.tabs.at(-1)!;
    const entered = env.gate(), finish = env.gate();
    tab.fill = async () => { entered.resolve(); await finish.promise; await tab.check(); };
    const call = env.start('/mcp', { jsonrpc: '2.0', id: inputId, method: 'tools/call',
      params: { name: 'figma.fill', arguments: { lease, locator, text: 'gated' } } }, owner.headers);
    void call.response.catch(() => undefined);
    await entered.promise;
    const cancelled = await env.send('/mcp', { jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: inputId } }, owner.headers);
    assert.equal(cancelled.status, 202, `Cancellation ${index + 1} must not exhaust HTTP admission: ${cancelled.bytes.toString()}`);
    await eventually(() => tab.closed, 'Cancellation must confirm target closure.');
    call.req.destroy();
    finish.resolve();
  }
  assert.equal((await env.send('/api/status')).status, 200);
});
