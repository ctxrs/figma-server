import assert from 'node:assert/strict';
import test from 'node:test';
import { FileLocks, bounded } from '../src/scheduler.js';
import { open, setup, tick, locator } from './helpers.js';

test('exclusive writer covers select → edit → verify → release across accounts, FIFO', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession(), c = env.core.sessions.createSession();
  const first = await open(env.core, a);
  let secondEntered = false, thirdEntered = false;
  const second = open(env.core, b, 'abcdef123', 'write', 'other').then(value => { secondEntered = true; return value; });
  const third = open(env.core, c).then(value => { thirdEntered = true; return value; });
  await tick(); assert.equal(secondEntered, false); assert.equal(thirdEntered, false);
  await env.core.call(a, 'figma.pointer_click', { lease: first.lease, point: { x: 500, y: 500 } });
  await env.core.call(a, 'figma.type_text', { lease: first.lease, text: 'Frame title' });
  await env.core.call(a, 'figma.verify', { lease: first.lease, expectation: { saved: true } });
  assert.equal(secondEntered, false);
  await env.core.call(a, 'figma.release', { lease: first.lease });
  const secondLease = await second; assert.equal(thirdEntered, false);
  await env.core.call(b, 'figma.release', { lease: secondLease.lease });
  const thirdLease = await third; assert.equal(thirdEntered, true);
  assert.notEqual(first.targetId, secondLease.targetId); assert.notEqual(secondLease.targetId, thirdLease.targetId);
});

test('different files run in parallel and sessions cannot drive one another’s target', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession();
  const first = await open(env.core, a);
  const second = await open(env.core, b, 'second123');
  assert.notEqual(first.targetId, second.targetId);
  await assert.rejects(env.core.call(b, 'figma.click', { lease: first.lease, locator }), /session/);
  const results = await Promise.all([env.core.call(a, 'figma.click', { lease: first.lease, locator }), env.core.call(b, 'figma.click', { lease: second.lease, locator })]);
  assert.equal((results[0] as { status: string }).status, 'unverified');
  assert.equal((results[1] as { status: string }).status, 'unverified');
});

test('read leases cannot mutate and released generations cannot be reused', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession();
  const lease = await open(env.core, a, 'abcdef123', 'read');
  await assert.rejects(env.core.call(a, 'figma.keypress', { lease: lease.lease, keys: 'F' }), /write lease/);
  await env.core.call(a, 'figma.release', { lease: lease.lease });
  await assert.rejects(env.core.call(a, 'figma.inspect', { lease: lease.lease }), /expired/);
});

test('FIFO queue removes cancelled waiters; bounded cancellation is indeterminate', async () => {
  const locks = new FileLocks();
  const unlock = await locks.acquire('file');
  const abort = new AbortController();
  const cancelled = locks.acquire('file', abort.signal);
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  unlock(); (await locks.acquire('file'))();
  await assert.rejects(bounded(new Promise(() => undefined), undefined, 5), /timed out/);
});

test('cancelled input holds file lock until target closure is confirmed', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession(), b = env.core.sessions.createSession();
  const first = await open(env.core, a);
  const tab = env.browser.tabs[0]!;
  let finishInput!: () => void, finishClose!: () => void;
  tab.block = new Promise(resolve => { finishInput = resolve; });
  tab.blockClose = new Promise(resolve => { finishClose = resolve; });
  const abort = new AbortController();
  const operation = env.core.call(a, 'figma.click', { lease: first.lease, locator }, abort.signal);
  await tick(); abort.abort();
  let nextEntered = false;
  const next = open(env.core, b).then(value => { nextEntered = true; return value; });
  await tick(); assert.equal(nextEntered, false);
  finishClose();
  assert.equal((await operation as { status: string }).status, 'indeterminate');
  const nextLease = await next; assert.equal(nextEntered, true); assert.ok(tab.closed);
  finishInput();
  await env.core.call(b, 'figma.release', { lease: nextLease.lease });
});

test('failed target close quarantines the file and keeps writer lock', async t => {
  const env = await setup(); t.after(env.cleanup);
  const a = env.core.sessions.createSession();
  const first = await open(env.core, a);
  const tab = env.browser.tabs[0]!; tab.failClose = true;
  await assert.rejects(env.core.call(a, 'figma.release', { lease: first.lease }), /quarantined/);
  assert.equal(env.core.sessions.leases.get(first.lease)?.quarantined, true);
  await assert.rejects(env.core.sessions.files.acquire('abcdef123', undefined, 10), /Timed out/);
  tab.failClose = false;
});

test('queued file writers do not consume tabs needed by unrelated files', async t => {
  const env = await setup(); t.after(env.cleanup);
  const first = env.core.sessions.createSession(); await open(env.core, first);
  const waiters: { id: string; promise: Promise<unknown> }[] = [];
  for (let i = 0; i < 8; i++) {
    const id = env.core.sessions.createSession();
    const promise = open(env.core, id);
    void promise.catch(() => undefined); waiters.push({ id, promise });
  }
  await tick();
  const independent = env.core.sessions.createSession();
  const lease = await open(env.core, independent, 'independent123');
  assert.ok(lease.lease); assert.equal(env.browser.tabs.length, 2);
  for (const waiter of waiters) { await env.core.sessions.closeSession(waiter.id); await assert.rejects(waiter.promise, /cancelled/); }
});
