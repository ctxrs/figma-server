import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import test from 'node:test';
import { LIMITS } from '../src/security.js';
import { open, setup, tick, locator } from './helpers.js';

test('browser crash invalidates generation, closes tabs and releases file lease', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(); const first = await open(env.core, a);
  env.browser.crash(); await tick();
  assert.equal(env.core.sessions.leases.size, 0);
  await assert.rejects(env.core.call(a, 'figma.inspect', { lease: first.lease }));
  (await env.core.sessions.files.acquire('abcdef123', undefined, 10))();
});

test('session disconnect closes all owned tabs and cancels pending file acquisition', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession();
  await open(env.core, a);
  const pending = open(env.core, b);
  await tick(); await env.core.sessions.closeSession(b);
  await assert.rejects(pending, /cancelled/);
  await env.core.sessions.closeSession(a);
  assert.equal(env.core.sessions.leases.size, 0); assert.ok(env.browser.tabs.every(tab => tab.closed));
});

test('idle lease expires, closes its target and leaves no permanent lock', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(); const first = await open(env.core, a);
  env.core.sessions.leases.get(first.lease)!.touched -= LIMITS.leaseMs + 1;
  await env.core.sessions.sweep();
  assert.equal(env.core.sessions.leases.size, 0); assert.ok(env.browser.tabs[0]!.closed);
});

test('receipts do not equate dispatched input with a saved edit or retain input secrets', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(); const lease = await open(env.core, a);
  const receipt = await env.core.call(a, 'figma.fill', { lease: lease.lease, locator, text: 'shortsyntheticsecret' }) as { jobId: string; status: string; beforeScreenshot: string; afterScreenshot: string };
  assert.equal(receipt.status, 'unverified'); assert.ok(receipt.beforeScreenshot); assert.ok(receipt.afterScreenshot);
  const saved = await readFile(env.state.path('artifacts', receipt.jobId, 'receipt.json'), 'utf8');
  assert.equal(saved.includes('shortsyntheticsecret'), false); assert.equal(saved.includes('locator'), false);
  const verified = await env.core.call(a, 'figma.verify', { lease: lease.lease, expectation: { saved: true } }) as { status: string };
  assert.equal(verified.status, 'verified');
});

test('artifacts enforce ownership, filename policy, byte limits and symlink denial', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession();
  const job = await env.core.artifacts.begin(a);
  await env.core.artifacts.image(job, 'screenshot', Buffer.alloc(10));
  await assert.rejects(env.core.artifacts.read(b, job, 'screenshot.png'), /session/);
  await assert.rejects(env.core.artifacts.read(a, job, '../../secret'), /Invalid/);
  await assert.rejects(env.core.artifacts.image(job, 'before', Buffer.alloc(LIMITS.artifactBytes + 1)), /size limit/);
  await symlink(env.state.path('secret'), env.state.path('artifacts', job, 'after.png'));
  await assert.rejects(env.core.artifacts.read(a, job, 'after.png'), /links/);
});

test('cancelled opening with failed closure is tracked and confirmed browser death recovers quarantine', async t => {
  const env = await setup(); t.after(env.cleanup);
  const owner = env.core.sessions.createSession();
  const controller = new AbortController();
  const original = env.browser.open.bind(env.browser);
  env.browser.open = async (account, url, key) => {
    const tab = await original(account, url, key);
    env.browser.tabs.at(-1)!.failClose = true;
    controller.abort();
    return tab;
  };
  await assert.rejects(env.core.sessions.open(owner, 'default', 'https://www.figma.com/design/quarantine123', 'write', controller.signal), /quarantined/);
  assert.equal([...env.core.sessions.leases.values()].filter(lease => lease.quarantined).length, 1);
  await assert.rejects(env.core.sessions.files.acquire('quarantine123', undefined, 5), /Timed out/);
  env.browser.crash(); await tick();
  assert.equal(env.core.sessions.leases.size, 0);
  (await env.core.sessions.files.acquire('quarantine123', undefined, 10))();
});

test('target-specific permission failure does not block a healthy existing lease', async t => {
  const env = await setup(); t.after(env.cleanup);
  const owner = env.core.sessions.createSession(); const lease = await open(env.core, owner);
  env.browser.states.set('default', { account: 'default', state: 'permission_denied', generation: env.browser.generation });
  assert.deepEqual(await env.core.call(owner, 'figma.inspect', { lease: lease.lease }), { layers: ['Frame 1'], accessibility: { treeitems: 1 } });
});
