import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '../src/main.js';
import { locator, open, setup, tick } from './helpers.js';

test('HTTP requires authentication for every adapter; Host and Origin cannot bypass it', async t => {
  const env = await setup();
  const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { await daemon.close(); await env.cleanup(); });
  assert.equal((await fetch(`${daemon.url}/api/status`)).status, 401);
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${daemon.url}/api/status`, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://attacker.invalid' } })).status, 403);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${daemon.url}/api/status`, { headers: { Authorization: `Bearer ${token}`, Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  const status = await fetch(`${daemon.url}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { accounts: unknown[] }).accounts.length, 1);
});

test('stable MCP 2025-06-18 initialization, tool schemas, images, artifacts and deletion', async t => {
  const env = await setup(); const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { await daemon.close(); await env.cleanup(); });
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const response = await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  } }) });
  assert.equal(response.status, 200);
  const initialized = await response.json() as { result: { protocolVersion: string } };
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  const session = response.headers.get('mcp-session-id'); assert.ok(session);
  const headers = { ...auth, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' };
  const rpc = async (id: number, method: string, params: unknown = {}) => {
    const result = await fetch(`${daemon.url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.equal(result.status, 200); return result.json() as Promise<{ result: { tools?: { name: string; inputSchema: object }[]; content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } }>;
  };
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
  const tools = (await rpc(2, 'tools/list')).result.tools!;
  assert.ok(tools.find(v => v.name === 'figma.type_text')); assert.ok(tools.find(v => v.name === 'figma.pointer_click'));
  const lease = JSON.parse((await rpc(3, 'tools/call', { name: 'figma.open', arguments: { file_url: 'https://www.figma.com/design/abcdef123' } })).result.content![0]!.text!) as { lease: string };
  const shot = (await rpc(4, 'tools/call', { name: 'figma.screenshot', arguments: { lease: lease.lease } })).result;
  assert.equal(shot.isError, false);
  const image = shot.content!.find(v => v.type === 'image')!;
  assert.equal(image.mimeType, 'image/png'); assert.ok(Buffer.from(image.data!, 'base64').length > 10);
  const artifact = JSON.parse(shot.content![0]!.text!) as { artifact: string };
  const retrieval = await fetch(`${daemon.url}/api/${artifact.artifact}`, { headers: { Authorization: `Bearer ${token}`, 'X-Figma-Session': session } });
  assert.equal(retrieval.status, 200); assert.equal(retrieval.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${daemon.url}/api/${artifact.artifact}`)).status, 401);
  const other = env.core.sessions.createSession();
  assert.equal((await fetch(`${daemon.url}/api/${artifact.artifact}`, { headers: { Authorization: `Bearer ${token}`, 'X-Figma-Session': other } })).status, 404);
  assert.equal((await rpc(5, 'tools/call', { name: 'figma.cdp', arguments: { ...lease, command: 'Runtime.evaluate', expression: 'document.cookie' } })).result.isError, true);
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: 'DELETE', headers })).status, 200);
  await tick(); assert.equal(env.core.sessions.leases.size, 0);
});

test('official SDK client works against authenticated HTTP surface', async t => {
  const env = await setup(); const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  const client = new Client({ name: 'official-sdk-test', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  t.after(async () => { await client.close(); await daemon.close(); await env.cleanup(); });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length >= 15);
  const result = await client.callTool({ name: 'figma.account_status', arguments: {} });
  assert.equal(result.isError, false);
});

test('JSON disconnected input invalidates lease and closes tab before unlock', async t => {
  const env = await setup(); const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { await daemon.close(); await env.cleanup(); });
  for (const mode of ['json']) {
    const session = env.core.sessions.createSession();
    let mcpSession = session;
    if (mode === 'mcp') {
      const result = await fetch(`${daemon.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
      mcpSession = result.headers.get('mcp-session-id')!; await result.arrayBuffer();
    }
    const first = await open(env.core, mcpSession);
    const tab = env.browser.tabs.at(-1)!;
    let finish!: () => void; tab.block = new Promise(resolve => { finish = resolve; });
    const pending = request(`${daemon.url}${mode === 'json' ? '/api/tools/figma.click' : '/mcp'}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'X-Figma-Session': mcpSession, 'Mcp-Session-Id': mcpSession, 'MCP-Protocol-Version': '2025-06-18',
    } });
    pending.on('error', () => undefined);
    pending.end(JSON.stringify(mode === 'json' ? { lease: first.lease, locator } : { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'figma.click', arguments: { lease: first.lease, locator } } }));
    await tick(); await tick(); pending.destroy();
    for (let i = 0; i < 20 && !tab.closed; i++) await tick();
    assert.equal(tab.closed, true, `${mode} disconnect must close its target`);
    assert.equal(env.core.sessions.leases.has(first.lease), false);
    finish();
  }
});

test('request body and path limits apply before JSON tool dispatch', async t => {
  const env = await setup(); const token = await env.state.secret();
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { await daemon.close(); await env.cleanup(); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${daemon.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ big: 'x'.repeat(150_000) }) })).status, 413);
  assert.equal((await fetch(`${daemon.url}/api/artifacts/job_x/%2e%2e`, { headers })).status, 400);
});

test('authenticated login cancellation drains headed bootstrap and clears authorizing state', async t => {
  const env = await setup(); const token = await env.state.secret();
  let authorizing = false;
  env.browser.login = async (account, confirm) => {
    authorizing = true;
    try { await confirm(); return env.browser.status(account); }
    finally { authorizing = false; }
  };
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { await daemon.close(); await env.cleanup(); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const start = await fetch(`${daemon.url}/api/login/start`, { method: 'POST', headers, body: '{"account":"default"}' });
  assert.equal(start.status, 202); assert.equal(authorizing, true);
  const login = await start.json() as { login: string };
  assert.equal((await fetch(`${daemon.url}/api/login/cancel`, { method: 'POST', headers, body: '{"login":"../../secret"}' })).status, 400);
  const cancel = await fetch(`${daemon.url}/api/login/cancel`, { method: 'POST', headers, body: JSON.stringify({ login: login.login }) });
  assert.equal(cancel.status, 200); assert.equal(authorizing, false);
  assert.equal((await fetch(`${daemon.url}/api/login/confirm`, { method: 'POST', headers, body: JSON.stringify({ login: login.login }) })).status, 404);
  const owner = env.core.sessions.createSession(); assert.ok((await open(env.core, owner)).lease);
});

test('undelivered login bootstrap cancels and drains gated launch before admitting the next login', { timeout: 5000 }, async t => {
  const env = await setup(); const token = await env.state.secret();
  let launch!: () => void;
  let started!: () => void;
  let cleaned!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const launched = new Promise<void>(resolve => { launch = resolve; });
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  let active = false;
  let starts = 0;
  env.browser.login = async (account, confirm) => {
    active = true;
    starts++;
    try {
      if (starts === 1) { started(); await launched; }
      await confirm(); return env.browser.status(account);
    } finally { active = false; if (starts === 1) cleaned(); }
  };
  const daemon = await serve(env.core, { port: 0, token, accounts: ['default'] });
  t.after(async () => { launch(); await daemon.close(); await env.cleanup(); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const pending = request(`${daemon.url}/api/login/start`, { method: 'POST', headers });
  pending.on('error', () => undefined);
  pending.end('{"account":"default"}');
  await starting;
  assert.equal(active, true);
  pending.destroy();
  await tick(); await tick();
  assert.equal((await fetch(`${daemon.url}/api/login/start`, { method: 'POST', headers, body: '{"account":"default"}' })).status, 409);
  launch();
  await cleanup;
  await tick();
  assert.equal(active, false);
  const next = await fetch(`${daemon.url}/api/login/start`, { method: 'POST', headers, body: '{"account":"default"}' });
  assert.equal(next.status, 202);
  const login = await next.json() as { login: string };
  assert.equal(active, true);
  assert.equal((await fetch(`${daemon.url}/api/login/cancel`, { method: 'POST', headers, body: JSON.stringify({ login: login.login }) })).status, 200);
  assert.equal(active, false);
});
