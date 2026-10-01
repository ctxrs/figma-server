import assert from 'node:assert/strict';
import test from 'node:test';
import type { Locator, Page } from 'playwright';
import type { BrowserTab } from '../src/browser-supervisor.js';
import { fault } from '../src/errors.js';
import { verify } from '../src/figma-adapter.js';
import type { Receipt } from '../src/receipts.js';
import type { Expectation } from '../src/security.js';
import { open, setup } from './helpers.js';

type ObservedElement = { role: 'status' | 'treeitem'; text: string; visible: boolean };

// Controlled browser observations, not a live Figma fixture. The real adapter
// evaluates them through the real core and writes its normal verification receipt.
function observedPage(elements: ObservedElement[]): Page {
  function collection(matches: ObservedElement[]): Locator {
    return {
      count: async () => matches.length,
      nth: (index: number) => collection(matches.slice(index, index + 1)),
      filter: ({ hasText }: { hasText: string | RegExp }) => collection(matches.filter(element =>
        typeof hasText === 'string' ? element.text.includes(hasText) : hasText.test(element.text))),
      isVisible: async () => {
        assert.ok(matches.length <= 1, 'Ambiguous observations cannot be resolved as one element.');
        return matches[0]?.visible ?? false;
      },
      innerText: async () => {
        assert.equal(matches.length, 1);
        return matches[0]!.text;
      },
    } as unknown as Locator;
  }
  return {
    getByRole: (role: string, options?: { name?: string | RegExp }) => collection(elements.filter(element =>
      element.role === role && (options?.name === undefined || (typeof options.name === 'string'
        ? element.text === options.name : options.name.test(element.text))))),
    getByText: (text: string | RegExp) => collection(elements.filter(element =>
      typeof text === 'string' ? element.text === text : text.test(element.text))),
  } as unknown as Page;
}

async function observe(t: { after: (cleanup: () => Promise<void>) => unknown },
  elements: ObservedElement[], expectation: Expectation): Promise<Receipt> {
  const env = await setup();
  t.after(env.cleanup);
  const session = env.core.sessions.createSession();
  const lease = await open(env.core, session);
  const tab: BrowserTab = env.browser.tabs[0]!;
  const page = observedPage(elements);
  tab.verify = expected => verify(page, expected);
  return await env.core.call(session, 'figma.verify', { lease: lease.lease, expectation }) as Receipt;
}

for (const scenario of [
  { name: 'a layer named All changes saved is not a save indicator',
    elements: [{ role: 'treeitem', text: 'All changes saved', visible: true }], saved: false },
  { name: 'a hidden saved status is not an observed save',
    elements: [{ role: 'status', text: 'All changes saved', visible: false }], saved: false },
  { name: 'a saving status plus a saved-looking layer remains unknown',
    elements: [{ role: 'status', text: 'Saving…', visible: true },
      { role: 'treeitem', text: 'All changes saved', visible: true }], saved: false },
  { name: 'no status leaves save observation unknown', elements: [], saved: false },
  { name: 'a visible saved status verifies only the requested save observation',
    elements: [{ role: 'status', text: 'All changes saved', visible: true }], saved: true },
] satisfies { name: string; elements: ObservedElement[]; saved: boolean }[]) {
  test(scenario.name, async t => {
    const receipt = await observe(t, scenario.elements, { saved: true });
    assert.equal(receipt.status, scenario.saved ? 'verified' : 'unverified');
    assert.equal(receipt.verification?.saveState, scenario.saved ? 'saved' : 'unknown');
    assert.deepEqual(receipt.verification?.checks, scenario.saved ? ['saved'] : []);
    assert.ok(receipt.beforeScreenshot);
    assert.ok(receipt.afterScreenshot);
  });
}

test('duplicate visible layers cannot verify visible:false', async t => {
  // Regression: the original adapter confused "not uniquely visible" with
  // "not visible" and verified this expectation despite both layers being visible.
  const receipt = await observe(t, [
    { role: 'treeitem', text: 'Draft marker', visible: true },
    { role: 'treeitem', text: 'Draft marker', visible: true },
  ], { locator: { by: 'role', role: 'treeitem', name: 'Draft marker' }, visible: false });
  assert.equal(receipt.status, 'unverified');
  assert.ok(!receipt.verification?.checks.includes('visibility'));
});

test('an absent layer can verify visible:false without claiming saved state', async t => {
  const receipt = await observe(t, [], {
    locator: { by: 'role', role: 'treeitem', name: 'Draft marker' }, visible: false,
  });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.verification?.saveState, 'unknown');
  assert.deepEqual(receipt.verification?.checks, ['visibility']);
});

test('a visible layer cannot verify visible:false', async t => {
  const receipt = await observe(t, [{ role: 'treeitem', text: 'Draft marker', visible: true }], {
    locator: { by: 'role', role: 'treeitem', name: 'Draft marker' }, visible: false,
  });
  assert.equal(receipt.status, 'unverified');
  assert.ok(!receipt.verification?.checks.includes('visibility'));
});

test('a denied file open does not prevent inspecting and releasing a healthy lease', async t => {
  const env = await setup();
  t.after(env.cleanup);
  const session = env.core.sessions.createSession();
  const healthy = await open(env.core, session);
  const originalOpen = env.browser.open.bind(env.browser);
  env.browser.open = async (account, url, key) => {
    if (key === 'DeniedFile123') {
      env.browser.states.set(account, { ...env.browser.status(account), state: 'permission_denied' });
      fault('permission_denied', 'This file is not accessible.', 403);
    }
    return originalOpen(account, url, key);
  };
  await assert.rejects(open(env.core, session, 'DeniedFile123'), { code: 'permission_denied' });
  assert.deepEqual(await env.core.call(session, 'figma.inspect', { lease: healthy.lease }), {
    layers: ['Frame 1'], accessibility: { treeitems: 1 },
  });
  assert.deepEqual(await env.core.call(session, 'figma.release', { lease: healthy.lease }), { released: true });
  assert.ok(env.browser.tabs[0]!.closed);
  assert.equal(env.core.sessions.leases.size, 0);
  (await env.core.sessions.files.acquire(healthy.fileKey, undefined, 10))();
});
