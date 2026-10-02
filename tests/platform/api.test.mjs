import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { productionModule, packageRoot } from './runtime.mjs';
import { auditWindowsAcl } from './windows-acl.mjs';
import { firstKey, secondKey, file, pngSignature, attachFixture, launchFixture } from './fixture.mjs';

const { State, Metadata } = await productionModule('state');
const { BrowserSupervisor } = await productionModule('browser-supervisor');
const { Core } = await productionModule('core');
const { serve } = await productionModule('main');
const require = createRequire(join(packageRoot, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);

test('real Chromium behind MCP and HTTP: auth, ownership, artifacts and shared write locks', { timeout: 90_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-api-fixture-')));
  const state = new State(root);
  const config = { version: 1, accounts: [{ name: 'default', loginOrigins: [] }],
    ...(process.env.QUALIFY_SYSTEM_BROWSER ? { browser: process.env.QUALIFY_SYSTEM_BROWSER } : {}) };
  await state.init(config);
  const browser = new BrowserSupervisor(state, config, launchFixture);
  const core = new Core(browser, state, await Metadata.open(state));
  const token = await state.secret();
  let server;
  let client;
  t.after(async () => {
    try { await client?.close(); } finally {
      try { await server?.close(); } finally {
        await core.stop(); await rm(root, { recursive: true, force: true });
      }
    }
  });
  await browser.start();
  await attachFixture(browser);
  await assert.rejects(serve(core, { host: '0.0.0.0', port: 0, token, accounts: ['default'] }), error => error.code === 'unsafe_listen');
  server = await serve(core, { port: 0, token, accounts: ['default'] });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = (path, method = 'GET', data, extra = {}) => fetch(server.url + path, {
    method, headers: { ...headers, ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    redirect: 'error', signal: AbortSignal.timeout(35_000),
  });
  for (const path of ['/api/status', '/mcp']) {
    const result = await fetch(server.url + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(result.status, 401);
    await result.arrayBuffer();
  }
  const badToken = await request('/api/status', 'GET', undefined, { Authorization: 'Bearer invalid' });
  assert.equal(badToken.status, 401); await badToken.arrayBuffer();
  const badOrigin = await request('/api/status', 'GET', undefined, { Origin: 'https://untrusted.invalid' });
  assert.equal(badOrigin.status, 403); await badOrigin.arrayBuffer();
  // Fetch implementations may replace Host. Send the hostile header on the wire.
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(server.url + '/api/status', { headers: { ...headers, Host: 'untrusted.invalid' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Host boundary probe timed out')));
    req.once('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  const status = await request('/api/status');
  assert.equal(status.status, 200);
  assert.ok(!JSON.stringify(await status.json()).includes(token));
  const created = await request('/api/sessions', 'POST', {});
  assert.equal(created.status, 201);
  const { session } = await created.json();
  assert.match(session, /^[a-f0-9-]{36}$/);
  const httpTool = async (name, arguments_) => {
    const response = await request(`/api/tools/${name}`, 'POST', arguments_, { 'X-Figma-Session': session });
    const value = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  client = new Client({ name: 'credential-free-qualification', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), { requestInit: { headers } }));
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'figma.open'));
  const mcpTool = async (name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content.find(part => part.type === 'text').text);
  };
  const [alpha, beta] = await Promise.all([
    httpTool('figma.open', { file_url: file(firstKey), mode: 'write' }),
    mcpTool('figma.open', { file_url: file(secondKey), mode: 'write' }),
  ]);
  assert.notEqual(alpha.targetId, beta.targetId);
  assert.equal(core.sessions.leases.size, 2);
  const denied = await request('/api/tools/figma.inspect', 'POST', { lease: beta.lease }, { 'X-Figma-Session': session });
  assert.equal(denied.status, 404); await denied.arrayBuffer();
  const evaluation = await httpTool('figma.cdp', {
    lease: alpha.lease, command: 'Runtime.evaluate', params: { expression: 'Promise.resolve(42)', awaitPromise: true, returnByValue: true },
  });
  assert.equal(evaluation.result.result.value, 42);
  const metrics = await httpTool('figma.cdp', { lease: alpha.lease, command: 'Page.getLayoutMetrics' });
  assert.equal(metrics.result.cssLayoutViewport.clientWidth, 1920);

  const [alphaReceipt, betaReceipt] = await Promise.all([
    httpTool('figma.fill', { lease: alpha.lease, locator: { by: 'label', name: 'Description' }, text: 'HTTP tab marker' }),
    mcpTool('figma.fill', { lease: beta.lease, locator: { by: 'label', name: 'Description' }, text: 'MCP tab marker' }),
  ]);
  assert.equal(alphaReceipt.status, 'unverified');
  assert.equal(betaReceipt.status, 'unverified');
  const windowsReceiptAcl = await auditWindowsAcl([
    { path: state.path('metadata.sqlite'), protected: true },
    { path: state.path('artifacts', alphaReceipt.jobId, 'receipt.json'), protected: true },
    { path: state.path('artifacts', betaReceipt.jobId, 'receipt.json'), protected: true },
  ]);
  assert.ok(Math.max(Date.parse(alphaReceipt.startedAt), Date.parse(betaReceipt.startedAt))
    < Math.min(Date.parse(alphaReceipt.completedAt), Date.parse(betaReceipt.completedAt)), 'Different-file operations must overlap.');
  const [alphaInspect, betaInspect] = await Promise.all([
    httpTool('figma.inspect', { lease: alpha.lease }), mcpTool('figma.inspect', { lease: beta.lease }),
  ]);
  assert.ok(alphaInspect.layers.includes('HTTP tab marker'));
  assert.ok(betaInspect.layers.includes('MCP tab marker'));
  assert.ok(!alphaInspect.layers.includes('MCP tab marker'));
  assert.ok(!betaInspect.layers.includes('HTTP tab marker'));
  const [alphaShot, betaShot] = await Promise.all([
    httpTool('figma.screenshot', { lease: alpha.lease }), mcpTool('figma.screenshot', { lease: beta.lease }),
  ]);
  assert.notEqual(alphaShot.artifact, betaShot.artifact);
  assert.ok(!alphaShot.artifact.includes(root));
  const alphaBytes = await readFile(join(root, alphaShot.artifact));
  const betaBytes = await readFile(join(root, betaShot.artifact));
  assert.deepEqual(alphaBytes.subarray(0, 8), pngSignature);
  assert.deepEqual(betaBytes.subarray(0, 8), pngSignature);
  assert.ok(!alphaBytes.equals(betaBytes));
  const windowsArtifactAcl = await auditWindowsAcl([
    { path: join(root, alphaShot.artifact), protected: true },
    { path: join(root, betaShot.artifact), protected: true },
  ]);

  let acquired = false;
  const queued = mcpTool('figma.open', { file_url: `https://www.figma.com/file/${firstKey}?node-id=1%3A2`, mode: 'write' })
    .then(value => { acquired = true; return value; });
  await delay(100);
  assert.equal(acquired, false, 'MCP must share the HTTP write lease lock for aliases of the same file.');
  await httpTool('figma.release', { lease: alpha.lease });
  const next = await queued;
  assert.equal(next.fileKey, firstKey);
  assert.equal(acquired, true);
  await mcpTool('figma.release', { lease: next.lease });
  await mcpTool('figma.release', { lease: beta.lease });
  assert.equal(core.sessions.leases.size, 0);
  const expired = await request('/api/tools/figma.inspect', 'POST', { lease: alpha.lease }, { 'X-Figma-Session': session });
  assert.equal(expired.status, 404); await expired.arrayBuffer();
  const ended = await request('/api/sessions', 'DELETE', undefined, { 'X-Figma-Session': session });
  assert.equal(ended.status, 200); await ended.arrayBuffer();

  if (process.env.QUALIFY_OUTPUT) {
    await mkdir(process.env.QUALIFY_OUTPUT, { recursive: true });
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'api.json'), JSON.stringify({
    adapters: ['official MCP SDK Streamable HTTP client', 'JSON HTTP'],
    unauthenticated: 401, wrongToken: 401, invalidOrigin: 403, invalidHost: 403,
    crossSessionLease: 404, arbitraryRuntime: 400, releasedLease: 404,
    concurrentDifferentFiles: true, sameFileWriteLeaseQueuedAcrossAdapters: true,
    windowsReceiptAcl, windowsArtifactAcl,
    evidence: 'Real Chromium with local intercepted editor; no live Figma credentials.',
    }, null, 2) + '\n');
  }
});
