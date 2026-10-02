import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CdpChannel } from '../src/cdp.js';
import { PlaywrightTab, type BrowserTab } from '../src/browser-supervisor.js';
import type { Page, BrowserContext } from 'playwright';
import { LIMITS } from '../src/security.js';
import { serve } from '../src/main.js';
import { editorFixture, open, setup, tick } from './helpers.js';

const html = '<!doctype html><title>Controlled editor</title><canvas width="100" height="100"></canvas><div role="toolbar"><button aria-label="Draw">Draw</button></div>';
type Reply = { status: string; result: any; error?: { code: string; message: string } };
type Events = { status: string; events: { sequence: number; method: string; params: any }[]; cursor: number; dropped_events: number; has_more: boolean; closed: boolean };
async function real(t: test.TestContext) {
  const env = await editorFixture(html);
  t.after(env.cleanup);
  const session = env.core.sessions.createSession();
  const first = await open(env.core, session);
  const cdp = (command: string, params = {}, scope: 'tab' | 'browser' = 'tab', lease = first.lease) =>
    env.core.call(session, 'figma.cdp', { lease, command, params, scope }) as Promise<Reply>;
  const evaluate = (expression: string, lease = first.lease) => env.core.call(session, 'figma.evaluate', { lease, expression }) as Promise<Reply>;
  const events = (after = 0, wait_ms = 0, scope: 'tab' | 'browser' = 'tab', lease = first.lease) =>
    env.core.call(session, 'figma.cdp_events', { lease, after, wait_ms, scope }) as Promise<Events>;
  return { ...env, session, first, cdp, evaluate, events };
}

test('arbitrary async JavaScript, native DOM/Input/screenshot commands and useful errors retain the connection', async t => {
  const env = await real(t);
  assert.equal((await env.evaluate('Promise.resolve({nested:{answer:42},items:[1,2,3]})')).result.result.value.nested.answer, 42);
  const exception = await env.evaluate('throw new Error("controlled-exception")');
  assert.equal(exception.status, 'failed');
  assert.equal(exception.error?.code, 'javascript_exception');
  assert.match(exception.result.exceptionDetails.exception.description, /controlled-exception/);
  const unknown = await env.cdp('FixtureDomain.noSuchMethod');
  assert.equal(unknown.error?.code, 'cdp_protocol_error');
  assert.match(unknown.error!.message, /FixtureDomain|not found|wasn't found/);
  const bad = await env.cdp('DOM.getDocument', { depth: 'invalid' });
  assert.equal(bad.status, 'failed'); assert.match(bad.error!.message, /parameters|deserialize/i);
  assert.ok((await env.cdp('DOM.getDocument')).result.root.nodeId);
  await env.evaluate('globalThis.fixtureKeys=[];document.addEventListener("keydown",e=>fixtureKeys.push(e.key));0');
  assert.equal((await env.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x' })).status, 'completed');
  await env.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x' });
  assert.deepEqual((await env.evaluate('fixtureKeys')).result.result.value, ['x']);
  const png = Buffer.from((await env.cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await env.evaluate('document.querySelector("[role=toolbar]").remove();true');
  assert.equal((await env.evaluate('21*2')).result.result.value, 42, 'Raw tools do not require an editor toolbar.');
});

test('remote objects and enabled domains persist; detach resets only that scope', async t => {
  const env = await real(t);
  const object = (await env.cdp('Runtime.evaluate', { expression: '({persistentFixture:42})', returnByValue: false })).result.result.objectId;
  assert.ok(object);
  const properties = await env.cdp('Runtime.getProperties', { objectId: object, ownProperties: true });
  assert.equal(properties.result.result.find((p: any) => p.name === 'persistentFixture').value.value, 42);
  await env.cdp('Runtime.enable');
  await env.cdp('Browser.getVersion', {}, 'browser');
  await env.core.call(env.session, 'figma.cdp_close', { lease: env.first.lease });
  assert.equal((await env.cdp('Runtime.getProperties', { objectId: object })).status, 'failed');
  assert.equal((await env.cdp('Browser.getVersion', {}, 'browser')).status, 'completed');
  assert.equal((await env.evaluate('42')).result.result.value, 42);
});

test('event long-poll and Debugger.resume run concurrently with paused evaluation on the same lease', { timeout: 15_000 }, async t => {
  const env = await real(t);
  await env.cdp('Runtime.enable'); await env.cdp('Debugger.enable');
  let cursor = (await env.events()).cursor;
  const pendingEvents = env.events(cursor, 3000);
  await env.evaluate('console.log("controlled-concurrent-event");0');
  const batch = await pendingEvents;
  cursor = batch.cursor;
  let consoleSeen = batch.events.some(event => event.method === 'Runtime.consoleAPICalled');
  const consoleDeadline = Date.now() + 3000;
  while (!consoleSeen && Date.now() < consoleDeadline) {
    const received = await env.events(cursor, 300); cursor = received.cursor;
    consoleSeen = received.events.some(event => event.method === 'Runtime.consoleAPICalled');
  }
  assert.equal(consoleSeen, true);
  const pending = env.cdp('Runtime.evaluate', { expression: 'debugger;40+2', returnByValue: true });
  void pending.catch(() => undefined);
  let paused = false;
  const deadline = Date.now() + 4000;
  while (!paused && Date.now() < deadline) {
    const received = await env.events(cursor, 500); cursor = received.cursor;
    paused = received.events.some(event => event.method === 'Debugger.paused');
  }
  assert.equal(paused, true, 'The controlled evaluation actually paused in Chrome.');
  assert.equal((await env.cdp('Debugger.resume')).status, 'completed');
  assert.equal((await pending).result.result.value, 42);
});

test('bounded raw results and cursor overflow are explicit and the connection stays usable', async t => {
  const env = await real(t);
  const large = await env.evaluate('"x".repeat(1048576)');
  assert.equal(large.status, 'failed'); assert.equal(large.error?.code, 'cdp_output_limit');
  assert.equal((await env.evaluate('42')).result.result.value, 42);
  await env.cdp('Runtime.enable');
  await env.evaluate('for(let i=0;i<600;i++)console.log("controlled-burst",i);true');
  const batch = await env.events();
  assert.ok(batch.dropped_events > 0); assert.equal(batch.events.length, 100); assert.equal(batch.has_more, true);
  let cursor = batch.cursor;
  for (let i = 0; i < 6; i++) {
    const next = await env.events(cursor);
    assert.ok(next.events.every(event => event.sequence > cursor)); cursor = next.cursor;
    if (!next.has_more) break;
  }
  assert.equal((await env.evaluate('6*7')).result.result.value, 42);
});

test('Fetch.continueRequest and events remain usable while the same connection awaits a paused fetch', { timeout: 15_000 }, async t => {
  const env = await real(t);
  await env.cdp('Fetch.enable', { patterns: [{ urlPattern: '*controlled-fetch*', requestStage: 'Request' }] });
  let cursor = (await env.events()).cursor;
  const pending = env.cdp('Runtime.evaluate', { expression: 'fetch("/controlled-fetch").then(r=>r.status)', awaitPromise: true, returnByValue: true });
  void pending.catch(() => undefined);
  let requestId: string | undefined;
  const deadline = Date.now() + 4000;
  while (!requestId && Date.now() < deadline) {
    const batch = await env.events(cursor, 300); cursor = batch.cursor;
    requestId = batch.events.find(event => event.method === 'Fetch.requestPaused')?.params.requestId;
  }
  assert.ok(requestId, 'Chrome actually paused the request.');
  assert.equal((await env.cdp('Fetch.continueRequest', { requestId })).status, 'completed');
  assert.equal((await pending).result.result.value, 200);
});

test('trusted raw navigation and download configuration are not undone by managed UI guards', async t => {
  const env = await real(t);
  await env.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: env.state.path('artifacts'), eventsEnabled: true }, 'browser');
  await env.context().route('**/controlled-download', route => route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="fixture.txt"' }, body: 'controlled fixture bytes' }));
  const page = env.context().pages().find(page => page.url().includes('/design/'))!;
  assert.equal((await env.cdp('Page.navigate', { url: 'https://raw-navigation.invalid/controlled-editor' })).status, 'completed');
  await page.waitForURL('https://raw-navigation.invalid/controlled-editor');
  assert.equal((await env.evaluate('42')).result.result.value, 42);
  await env.cdp('Page.navigate', { url: 'https://raw-navigation.invalid/controlled-download' });
  let cursor = 0, completed = false;
  const deadline = Date.now() + 4000;
  while (!completed && Date.now() < deadline) {
    const batch = await env.events(cursor, 300, 'browser'); cursor = batch.cursor;
    assert.ok(!batch.events.some(event => event.method === 'Browser.downloadProgress' && event.params.state === 'canceled'));
    completed = batch.events.some(event => event.method === 'Browser.downloadProgress' && event.params.state === 'completed');
  }
  assert.equal(completed, true, 'The caller-selected synthetic download completed.');
  assert.equal(page.isClosed(), false);
});

test('shared browser scope supports native non-flattened child messages; release leaves caller-created targets and other agents healthy', async t => {
  const env = await real(t);
  const secondSession = env.core.sessions.createSession();
  const second = await open(env.core, secondSession, 'SyntheticFileB');
  const other = (command: string, params = {}, scope = 'browser') => env.core.call(secondSession, 'figma.cdp', { lease: second.lease, command, params, scope }) as Promise<Reply>;
  assert.equal((await other('Browser.getVersion')).status, 'completed');
  const targetId = (await env.cdp('Target.createTarget', { url: 'data:text/html,<title>Raw child fixture</title>' }, 'browser')).result.targetId;
  const sessionId = (await env.cdp('Target.attachToTarget', { targetId, flatten: false }, 'browser')).result.sessionId;
  const after = (await env.events(0, 0, 'browser')).cursor;
  assert.equal((await env.cdp('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 101, method: 'Runtime.evaluate', params: { expression: '6*7', returnByValue: true } }) }, 'browser')).status, 'completed');
  let cursor = after, value: number | undefined;
  const deadline = Date.now() + 4000;
  while (value === undefined && Date.now() < deadline) {
    const batch = await env.events(cursor, 300, 'browser'); cursor = batch.cursor;
    for (const event of batch.events) if (event.method === 'Target.receivedMessageFromTarget' && event.params.sessionId === sessionId) {
      const inner = JSON.parse(event.params.message);
      if (inner.id === 101) value = inner.result.result.value;
    }
  }
  assert.equal(value, 42, 'Chrome returned a native nested CDP response.');
  await env.core.call(env.session, 'figma.release', { lease: env.first.lease });
  const targets = await other('Target.getTargets');
  assert.ok(targets.result.targetInfos.some((target: any) => target.targetId === targetId));
  assert.equal((await other('Runtime.evaluate', { expression: '120', returnByValue: true }, 'tab')).result.result.value, 120);
  assert.equal((await other('Target.closeTarget', { targetId })).result.success, true);
});

test('successful raw target closure and private Browser.close return protocol acknowledgements without UI probes', async t => {
  const env = await real(t);
  const targetId = (await env.cdp('Target.getTargetInfo')).result.targetInfo.targetId;
  assert.equal((await env.cdp('Target.closeTarget', { targetId }, 'browser')).result.success, true);
  assert.equal((await env.cdp('Browser.getVersion', {}, 'browser')).status, 'completed');
  assert.equal((await env.cdp('Browser.close', {}, 'browser')).status, 'completed');
});

test('actual MCP and JSON HTTP expose raw tools, enforce ownership/auth/input bounds and preserve useful errors', async t => {
  const env = await editorFixture(html);
  const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  const client = new Client({ name: 'controlled-cdp-transport-test', version: '1' });
  t.after(async () => { await client.close(); await daemon.close(); await env.cleanup(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(daemon.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['figma.evaluate', 'figma.cdp', 'figma.cdp_events', 'figma.cdp_close']) assert.ok(tools.includes(name));
  const opened = await client.callTool({ name: 'figma.open', arguments: { file_url: 'https://www.figma.com/design/ControlledMCP01' } });
  const lease = JSON.parse((opened.content as any[])[0].text).lease;
  const evaluation = await client.callTool({ name: 'figma.evaluate', arguments: { lease, expression: 'Promise.resolve({answer:42})' } });
  assert.equal(evaluation.isError, false); assert.equal(JSON.parse((evaluation.content as any[])[0].text).result.result.value.answer, 42);
  const unknown = await client.callTool({ name: 'figma.cdp', arguments: { lease, command: 'Controlled.noSuchMethod' } });
  assert.equal(unknown.isError, true); assert.match(JSON.parse((unknown.content as any[])[0].text).error.message, /Controlled|found/);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sessionResponse = await fetch(daemon.url + '/api/sessions', { method: 'POST', headers, body: '{}' });
  const session = (await sessionResponse.json() as { session: string }).session;
  const jsonHeaders = { ...headers, 'X-Figma-Session': session };
  const call = (name: string, args: unknown, auth: Record<string, string> = jsonHeaders) => fetch(daemon.url + '/api/tools/' + name, { method: 'POST', headers: auth, body: JSON.stringify(args) });
  assert.equal((await call('figma.evaluate', { lease, expression: '42' }, { 'Content-Type': 'application/json', 'X-Figma-Session': session } as typeof jsonHeaders)).status, 401);
  assert.equal((await call('figma.evaluate', { lease, expression: '42' })).status, 404);
  const jsonOpen = await call('figma.open', { file_url: 'https://www.figma.com/design/ControlledJSON02' });
  const own = await jsonOpen.json() as { lease: string };
  const reply = await call('figma.cdp', { lease: own.lease, command: 'Browser.getVersion', scope: 'browser' });
  assert.equal(reply.status, 200); assert.equal((await reply.json() as Reply).status, 'completed');
  assert.equal((await call('figma.cdp', { lease: own.lease, command: 'Runtime.evaluate', params: { expression: 'x'.repeat(LIMITS.bodyBytes) } })).status, 413);
  const badOrigin = await call('figma.evaluate', { lease: own.lease, expression: '42' }, { ...jsonHeaders, Origin: 'https://untrusted.invalid' });
  assert.equal(badOrigin.status, 403);
});

test('explicit release discards a late raw result without stopping another agent', async t => {
  const env = await setup(); t.after(env.cleanup);
  const session = env.core.sessions.createSession(); const first = await open(env.core, session);
  const second = await open(env.core, session, 'OtherControlledFile');
  const tab: BrowserTab = env.browser.tabs[0]!;
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  tab.checkRaw = async () => { await tab.check(); };
  tab.cdp = async () => { entered(); await pending; return { status: 'completed', result: { result: { value: 42 } } }; };
  const result = env.core.call(session, 'figma.evaluate', { lease: first.lease, expression: '42' });
  void result.catch(() => undefined); await started;
  await env.core.call(session, 'figma.release', { lease: first.lease }); finish();
  await assert.rejects(result, (error: any) => error.code === 'indeterminate');
  assert.equal(env.browser.tabs[1]!.closed, false);
  assert.ok(await env.core.call(session, 'figma.inspect', { lease: second.lease }));
});

test('raw timeout, read ownership and failed resource close preserve quarantine until confirmed teardown', async t => {
  const env = await setup(); t.after(env.cleanup);
  const session = env.core.sessions.createSession(); const read = await open(env.core, session, 'ReadOnlyFixture', 'read');
  await assert.rejects(env.core.call(session, 'figma.evaluate', { lease: read.lease, expression: '42' }), (error: any) => error.code === 'read_only');
  const first = await open(env.core, session);
  const tab: BrowserTab = env.browser.tabs[1]!;
  tab.checkRaw = async () => { await tab.check(); };
  tab.cdp = async () => new Promise(() => {});
  env.browser.tabs[1]!.failClose = true;
  await assert.rejects(env.core.call(session, 'figma.evaluate', { lease: first.lease, expression: '42', timeout_ms: 20 }), (error: any) => error.code === 'indeterminate');
  assert.equal(env.core.sessions.leases.get(first.lease)?.quarantined, true);
  assert.equal(env.core.sessions.leases.get(first.lease)?.invalid, true);
  env.browser.crash(); await tick(); await tick();
  assert.equal(env.core.sessions.leases.has(first.lease), false);
});

for (const revoke of ['cancel', 'expire'] as const) {
  test(`${revoke} discards a delayed raw acknowledgement and preserves another lease`, async t => {
    const env = await setup(); t.after(env.cleanup);
    const session = env.core.sessions.createSession(), first = await open(env.core, session);
    const second = await open(env.core, session, 'HealthyExpiryFixture');
    const tab = env.browser.tabs[0]!;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const managed: BrowserTab = tab;
    managed.checkRaw = async () => { await tab.check(); };
    managed.cdp = async () => { entered(); await held; return { status: 'completed', result: {} }; };
    const controller = new AbortController();
    const pending = env.core.call(session, 'figma.cdp', { lease: first.lease, command: 'Browser.getVersion' }, controller.signal);
    void pending.catch(() => undefined); await started;
    if (revoke === 'cancel') controller.abort();
    else env.core.sessions.leases.get(first.lease)!.touched = Date.now() - LIMITS.leaseMs - 1;
    finish();
    await assert.rejects(pending, (error: any) => error.code === 'indeterminate');
    assert.equal(tab.closed, true); assert.equal(env.browser.tabs[1]!.closed, false);
    assert.ok(await env.core.call(session, 'figma.inspect', { lease: second.lease }));
  });
}

test('attachment after timeout detaches its own session without enabling raw authority or freeing an unconfirmed handle', { timeout: 10_000 }, async t => {
  const env = await setup(); t.after(env.cleanup);
  const owner = env.core.sessions.createSession(), first = await open(env.core, owner);
  const other = await open(env.core, owner, 'LateAttachHealthy');
  let attached!: (session: CDPSession) => void, entered!: () => void, enabled = false, closed = false, detaches = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const attachment = new Promise<CDPSession>(resolve => { attached = resolve; });
  const contextEmitter = Object.assign(new EventEmitter(), {
    browser: () => ({ isConnected: () => true }),
    newCDPSession: async () => { entered(); return attachment; },
  });
  const context = contextEmitter as unknown as BrowserContext;
  const page = { isClosed: () => closed } as Page;
  env.core.sessions.leases.get(first.lease)!.tab = new PlaywrightTab(page, context, first.fileKey,
    env.browser.generation, () => true, async () => { closed = true; }, { enable: () => { enabled = true; }, valid: () => true });
  const pending = env.core.call(owner, 'figma.evaluate', { lease: first.lease, expression: '42', timeout_ms: 20 });
  void pending.catch(() => undefined); await started;
  await assert.rejects(pending, (error: any) => error.code === 'indeterminate');
  assert.equal(closed, true); assert.equal(env.core.sessions.leases.get(first.lease)?.quarantined, true);
  assert.equal(enabled, false);
  const session = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => { detaches++; session.emit('close'); } });
  attached(session as unknown as CDPSession); await tick(); await tick();
  assert.equal(detaches, 1); assert.equal(enabled, false);
  assert.equal(env.core.sessions.leases.has(first.lease), false, 'Only the confirmed late detach frees the quarantine.');
  assert.equal(contextEmitter.listenerCount('close'), 0);
  assert.ok(await env.core.call(owner, 'figma.inspect', { lease: other.lease }));
});

test('oversize individual events are dropped explicitly and detach wakes a waiting reader', async () => {
  const emitter = new EventEmitter();
  const session = Object.assign(emitter, { send: async () => ({}), detach: async () => { emitter.emit('close'); } });
  const channel = new CdpChannel(session as unknown as CDPSession);
  emitter.emit('event', { method: 'Controlled.hugeEvent', params: { value: 'x'.repeat(LIMITS.cdpResultBytes + 1) } });
  const batch = await channel.events(0, 100, 0);
  assert.equal(batch.dropped_events, 1); assert.deepEqual(batch.events, []); assert.equal(batch.cursor, 1);
  const waiting = channel.events(1, 100, 3000);
  await channel.close(); assert.equal((await waiting).closed, true); assert.equal(emitter.listenerCount('event'), 0);
});
