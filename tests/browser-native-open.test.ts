import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { BrowserSupervisor } from '../src/browser-supervisor.js';
import { SessionManager } from '../src/session-manager.js';
import { Metadata, State } from '../src/state.js';
import { LIMITS } from '../src/security.js';

const alpha = 'SyntheticAlpha01', beta = 'SyntheticBeta02';
const file = (key: string) => `https://www.figma.com/design/${key}`;
const editor = '<button data-testid="filename">Identical file name</button><canvas width="600" height="300"></canvas><button data-testid="Frame-tool">Frame</button><button data-testid="Text-tool">Text</button><button data-testid="Text-tool" hidden disabled>Text</button><button data-testid="Frame-tool" hidden disabled>Frame</button>';
type Options = { popup?: boolean | 'direct'; wrongIdentity?: boolean; noIdentity?: boolean; duplicates?: boolean; invisible?: boolean; slow?: boolean; ancillary?: boolean; preAction?: boolean; hoverPreAction?: boolean; subframe?: boolean; wrongPayload?: boolean; wrongName?: boolean; ambiguousTools?: boolean; dirtyDashboard?: boolean; foreignPage?: boolean; malformed?: boolean; oversized?: boolean; editorDelay?: number; dashboardBlockedFrame?: boolean; metadataPressure?: boolean; wrongLoader?: boolean; cachedMetadata?: boolean };
function dashboard(options: Options): string {
  return `<!doctype html><h1>Recents</h1><button id="drafts">Drafts</button>
    <div data-testid="loading-content-pane-loading-skeleton" style="opacity:0;position:absolute;pointer-events:none">Loading</div>
    <div id="cards" style="display:flex;gap:30px"></div>${options.dirtyDashboard ? '<canvas></canvas>' : ''}<script>
    const options = ${JSON.stringify(options)};
    const keys = ${JSON.stringify([alpha, beta])};
    if (options.preAction) fetch('/api/file_metadata/' + keys[0]);
    document.querySelector('#drafts').onclick = () => document.querySelector('h1').textContent = 'Drafts';
    function add(key) {
      const item = document.createElement('div'); item.setAttribute('role','listitem');
      const card = document.createElement('button'); card.textContent = 'Identical file name'; card.style = 'width:297px;height:227px';
      if (options.invisible && key === keys[0]) item.style.opacity = '0';
      // Synthetic card-local React fiber shape; no real account metadata.
      card.__reactFiber$fixture = {memoizedProps:{},return:{memoizedProps:{bottomRightContent:{props:{tile:{file:{key}}}}}}};
      if (options.hoverPreAction) card.onmouseenter = () => fetch('/api/file_metadata/' + key);
      card.ondblclick = () => {
        const ownKey = options.wrongIdentity ? keys[1] : key;
        if (options.popup === 'direct') window.open('/design/' + key);
        else if (options.popup) { const popup = window.open('about:blank'); setTimeout(() => popup.location.href = '/design/' + key, 50); }
        else {
          history.pushState({}, '', '/design/' + key);
          const render = () => { document.body.innerHTML = ${JSON.stringify(editor)}; };
          if (options.editorDelay) { document.body.innerHTML = "Loading editor"; setTimeout(render, options.editorDelay); } else render();
          if (options.ambiguousTools) { const tool = document.createElement('button'); tool.dataset.testid = 'Text-tool'; tool.textContent = 'Text'; document.body.append(tool); }
          if (!options.noIdentity) fetch('/api/file_metadata/' + ownKey);
          if (options.foreignPage && key === keys[1]) fetch('/api/file_metadata/' + keys[0]);
          if (options.ancillary) fetch('/api/noop?requested=' + key);
          if (options.preAction || options.hoverPreAction) fetch('/api/after-action-release');
          if (options.subframe) {
            const frame = document.createElement('iframe'); frame.src = '/frame-data/' + key; document.body.append(frame);
          }
        }
      };
      item.append(card); document.querySelector('#cards').append(item);
    }
    if (options.dashboardBlockedFrame) {
      const frame=document.createElement('iframe'); frame.onload=()=>keys.forEach(add);
      frame.src='https://external.invalid/blocked-dashboard-frame'; document.body.append(frame);
    } else keys.forEach(add); if (options.duplicates) add(keys[0]);
    </script>`;
}
async function environment(t: TestContext, options: Options = {}) {
  const executable = process.env.FIGMA_SERVER_TEST_BROWSER;
  if (!executable) { t.skip('Set FIGMA_SERVER_TEST_BROWSER for isolated Chromium dashboard-card tests.'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-native-card-test-')));
  const state = new State(root);
  await state.init({ version: 1, browser: executable, accounts: [{ name: 'default', loginOrigins: [] }] });
  let context!: BrowserContext;
  const dispatched: string[] = [];
  const blockedChildErrorDocuments: boolean[] = [];
  const foreignDashboardChildCommits: boolean[] = [];
  const metadataBodyErrors: string[] = [];
  let pressureResponses = 0;
  let hold!: () => void;
  const gate = new Promise<void>(resolve => { hold = resolve; });
  const launcher: typeof chromium.launchPersistentContext = async (profile, settings) => {
    assert.equal(settings?.chromiumSandbox, true);
    context = await chromium.launchPersistentContext(profile, settings);
    context.on('page', page => page.on('framenavigated', frame => {
      if (frame.url() === 'chrome-error://chromewebdata/') blockedChildErrorDocuments.push(frame !== page.mainFrame());
      if (frame.url() === 'https://external.invalid/blocked-dashboard-frame') foreignDashboardChildCommits.push(frame !== page.mainFrame());
    }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      dispatched.push(url.origin + url.pathname);
      if (url.origin !== 'https://www.figma.com') return route.fulfill({ body: 'unsafe dispatch' });
      if (url.pathname.startsWith('/frame-data/')) return route.fulfill({ contentType: 'text/html',
        body: `<script>fetch('/api/file_metadata/${url.pathname.split('/')[2]}')</script>` });
      if (url.pathname.startsWith('/api/inspector-pressure/')) {
        pressureResponses++;
        return route.fulfill({ contentType: 'application/octet-stream', body: 'p'.repeat(48 * 1024) });
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/after-action-release') hold();
        if (options.slow || (options.preAction || options.hoverPreAction) && url.pathname === '/api/file_metadata/' + alpha) await gate;
        return route.fulfill({ contentType: 'application/json', body: options.malformed ? '{' : options.oversized ? 'x'.repeat(70000)
          : JSON.stringify({ meta: { file_key: options.wrongPayload ? beta : url.pathname.split('/').at(-1), name: options.wrongName ? 'Different visible name' : 'Identical file name' } }) });
      }
      if (url.pathname === '/files/recents') return route.fulfill({ contentType: 'text/html', body: dashboard(options) });
      const popup = await request.frame().page().opener();
      if (popup && options.popup) return route.fulfill({ contentType: 'text/html', body: editor + `<script>fetch('/api/file_metadata/${url.pathname.split('/')[2]}')</script>` });
      return route.fulfill({ status: 403, body: 'Direct document request blocked' });
    });
    if (options.metadataPressure || options.wrongLoader || options.cachedMetadata) {
      const attach = context.newCDPSession.bind(context);
      context.newCDPSession = async page => {
        const actual = await attach(page);
        let enabled = false, pressured = false;
        actual.on('Network.responseReceived', event => {
          if (options.cachedMetadata && new URL(event.response.url).pathname.startsWith('/api/file_metadata/')) {
            Reflect.apply(Reflect.get(actual, 'emit'), actual, ['Network.requestServedFromCache', { requestId: event.requestId }]);
          }
        });
        return new Proxy(actual, { get(value, field) {
          if (field === 'send') return async (method: string, parameters?: unknown) => {
            if (method === 'Page.getFrameTree' && enabled && options.metadataPressure && !pressured) {
              pressured = true;
              // Real, completed XHR bodies displace the tiny metadata response in
              // Chromium's inspector while the normal loader-validation RPC waits.
              await page.evaluate(async () => {
                for (let i = 0; i < 8; i++) await (await fetch('/api/inspector-pressure/' + i)).arrayBuffer();
              });
              await new Promise(resolve => setTimeout(resolve, 35));
            }
            try {
              const result = await Reflect.apply(value.send, value, [method, parameters]);
              if (method === 'Network.enable') enabled = true;
              if (method === 'Page.getFrameTree' && enabled && options.wrongLoader) {
                result.frameTree.frame.loaderId = 'SyntheticOtherDocumentLoader';
              }
              return result;
            } catch (error) {
              if (method === 'Network.getResponseBody') metadataBodyErrors.push((error as Error).message);
              throw error;
            }
          };
          const result = Reflect.get(value, field);
          return typeof result === 'function' ? result.bind(value) : result;
        } }) as CDPSession;
      };
    }
    return context;
  };
  const browser = new BrowserSupervisor(state, await state.config(), launcher);
  const manager = new SessionManager(browser, await Metadata.open(state));
  t.after(async () => { hold(); await manager.stop(); await rm(root, { recursive: true, force: true }); });
  return { browser, manager, context: () => context, dispatched, hold, blockedChildErrorDocuments, foreignDashboardChildCommits, metadataBodyErrors, pressureResponses: () => pressureResponses };
}
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'bounded condition was not met');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function target(context: BrowserContext, key: string): Page {
  const page = context.pages().find(page => page.url() === file(key));
  assert.ok(page); return page;
}

test('exact card keys beat identical names; concurrent same-account opens keep independent targets and reject unrelated popups', { timeout: 40_000 }, async t => {
  const env = await environment(t); if (!env) return;
  const [a, b] = await Promise.all([env.browser.open('default', file(alpha), alpha), env.browser.open('default', file(beta), beta)]);
  assert.notEqual(a.target, b.target);
  await a.check(true); await b.check(true);
  assert.equal(await target(env.context(), alpha).getByTestId('Text-tool').count(), 2, 'Hidden disabled duplicate tool is retained.');
  assert.equal(env.context().pages().length, 3, 'Only fixed blank plus two leased pages remain.');
  const page = target(env.context(), alpha);
  await page.evaluate(() => { window.open('https://www.figma.com/design/Unrelated01'); window.open('https://external.invalid/denied'); });
  await until(() => env.context().pages().length === 3);
  assert.ok(!env.dispatched.includes('https://www.figma.com/design/Unrelated01'));
  assert.ok(!env.dispatched.includes('https://external.invalid/denied'));
  await page.evaluate(() => { const iframe = document.createElement('iframe'); iframe.src = 'https://external.invalid/frame'; document.body.append(iframe); });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!env.dispatched.includes('https://external.invalid/frame'));
  if (page.isClosed()) await assert.rejects(a.check(), { code: 'target_invalid' });
  await a.close(); assert.ok(!target(env.context(), beta).isClosed()); await b.check();
  await b.close(); assert.equal(env.context().pages().length, 1);
});

test('qualified metadata arriving before canvas and duplicate native controls waits for the editor', { timeout: 15_000 }, async t => {
  const env = await environment(t, { editorDelay: 1200 }); if (!env) return;
  const opening = env.browser.open('default', file(alpha), alpha);
  await until(() => env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
  assert.equal(await target(env.context(), alpha).locator('canvas').count(), 0);
  const tab = await opening; await tab.check(true);
  assert.equal(await target(env.context(), alpha).getByTestId('Text-tool').count(), 2);
  await tab.close();
});

test('normal broker release and reopen after raw grant tolerates a foreign dashboard child while another lease stays healthy', { timeout: 20_000 }, async t => {
  const env = await environment(t, { dashboardBlockedFrame: true }); if (!env) return;
  const a = env.manager.createSession(), b = env.manager.createSession();
  const first = await env.manager.open(a, 'default', file(alpha), 'write');
  const other = await env.manager.open(b, 'default', file(beta), 'write');
  assert.deepEqual(env.foreignDashboardChildCommits, []);
  assert.ok(!env.dispatched.includes('https://external.invalid/blocked-dashboard-frame'), 'Ordinary UI opening still denies the foreign child before raw grant.');
  const reply = await env.manager.executeRaw(a, first.lease as string, 'tab', lease =>
    lease.tab.cdp!('tab', 'Runtime.evaluate', { expression: '6*7', returnByValue: true }));
  assert.equal(reply.status, 'completed');
  await env.manager.release(a, first.lease as string);
  const reopened = await env.manager.open(a, 'default', file(alpha), 'write').finally(() => {
    assert.deepEqual(env.foreignDashboardChildCommits, [true], 'Exactly one admitted foreign child committed during the reopen.');
    t.diagnostic('Controlled foreign child commit observed after raw grant; main dashboard remained the requested opener.');
  });
  assert.equal(reopened.fileKey, alpha);
  await env.manager.get(a, reopened.lease as string).tab.check(true);
  assert.ok(env.dispatched.includes('https://external.invalid/blocked-dashboard-frame'));
  await env.manager.get(b, other.lease as string).tab.check(true);
  await env.manager.release(a, reopened.lease as string); await env.manager.release(b, other.lease as string);
  assert.equal(env.context().pages().length, 1);
});

for (const invalid of ['wrong-file metadata', 'subframe metadata'] as const) {
  test(`normal broker opening after raw grant rejects ${invalid} as requested main-document identity`, { timeout: 20_000 }, async t => {
    const options: Options = {};
    const env = await environment(t, options); if (!env) return;
    const session = env.manager.createSession();
    const first = await env.manager.open(session, 'default', file(alpha), 'write');
    await env.manager.executeRaw(session, first.lease as string, 'tab', lease =>
      lease.tab.cdp!('tab', 'Runtime.evaluate', { expression: '42', returnByValue: true }));
    await env.manager.release(session, first.lease as string);
    if (invalid === 'wrong-file metadata') options.wrongIdentity = true;
    else { options.noIdentity = true; options.subframe = true; }
    await assert.rejects(env.manager.open(session, 'default', file(alpha), 'write'), { code: 'ui_unsupported' });
    assert.equal(env.manager.leases.size, 0); assert.equal(env.context().pages().length, 1);
  });
}

test('retained metadata cannot survive a document epoch replacement while the editor is delayed', { timeout: 20_000 }, async t => {
  const env = await environment(t, { editorDelay: 1200 }); if (!env) return;
  const opening = env.browser.open('default', file(alpha), alpha);
  const rejected = assert.rejects(opening, { code: 'ui_unsupported' });
  await until(() => env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
  const page = target(env.context(), alpha);
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.goto(file(alpha));
  await page.setContent(editor);
  await rejected;
  assert.equal(env.context().pages().length, 1);
});

test('retained metadata cannot publish after worker loss before delayed editor readiness', { timeout: 15_000 }, async t => {
  const env = await environment(t, { editorDelay: 1200 }); if (!env) return;
  const opening = env.browser.open('default', file(alpha), alpha);
  const rejected = assert.rejects(opening);
  await until(() => env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
  await new Promise(resolve => setTimeout(resolve, 200));
  await env.browser.stop(); await rejected;
  assert.equal(env.browser.workers.size, 0);
});

test('correlated pending popup is adopted once and dashboard helper closes before publication', { timeout: 40_000 }, async t => {
  const env = await environment(t, { popup: true }); if (!env) return;
  const [a, b] = await Promise.all([env.browser.open('default', file(alpha), alpha), env.browser.open('default', file(beta), beta)]);
  await a.check(true); await b.check();
  assert.equal(env.context().pages().length, 3);
  assert.ok(await target(env.context(), alpha).opener() === null, 'Dashboard opener is confirmed closed.');
  await target(env.context(), alpha).evaluate(() => window.open('/design/SyntheticLate01'));
  await until(() => env.context().pages().length === 3);
  assert.ok(!env.dispatched.includes('https://www.figma.com/design/SyntheticLate01'));
  await a.close(); await b.close();
});

test('expected native popup initial document uses the same opener binding or fails closed before dispatch', { timeout: 20_000 }, async t => {
  const env = await environment(t, { popup: 'direct' }); if (!env) return;
  try {
    const tab = await env.browser.open('default', file(alpha), alpha);
    await tab.check(true);
    assert.equal(env.context().pages().length, 2);
    await tab.close();
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error);
    assert.ok(['ui_unsupported', 'network_error', 'crashed'].includes(String(error.code)));
    assert.equal(env.context().pages().length, 1);
  }
});

test('wrong-file network identity rejects a spoofed expected URL and ready canvas', { timeout: 40_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  assert.equal(env.context().pages().length, 1, 'Failure closes the owned dashboard/editor.');
});

test('an expected-key ancillary query cannot certify a different loaded file', { timeout: 20_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true, ancillary: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  assert.ok(env.dispatched.some(url => url.endsWith('/api/noop')), 'Expected-key ancillary request really succeeded.');
  assert.equal(env.context().pages().length, 1);
});

test('expected-key response initiated on the dashboard before activation cannot certify the new editor', { timeout: 20_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true, preAction: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  const before = env.dispatched.findIndex(url => url.endsWith('/api/file_metadata/' + alpha));
  const release = env.dispatched.findIndex(url => url.endsWith('/api/after-action-release'));
  assert.ok(before >= 0 && release > before, 'Expected-key request begins before activation and completes after release.');
  assert.equal(env.context().pages().length, 1);
});

test('a hover request initiated during actionability waits before the trusted double-click cannot certify the editor', { timeout: 20_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true, hoverPreAction: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  const before = env.dispatched.findIndex(url => url.endsWith('/api/file_metadata/' + alpha));
  const release = env.dispatched.findIndex(url => url.endsWith('/api/after-action-release'));
  assert.ok(before >= 0 && release > before);
  assert.equal(env.context().pages().length, 1);
});

test('expected-key document data from a same-origin subframe cannot certify the adopted main page', { timeout: 20_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true, subframe: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  assert.ok(env.dispatched.some(url => url.endsWith('/frame-data/' + alpha)));
  assert.ok(env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
  assert.equal(env.context().pages().length, 1);
});

for (const [name, options] of [
  ['wrong payload key despite an exact request and equal filenames', { wrongPayload: true }],
  ['metadata name disagrees with the delayed visible filename', { wrongName: true, editorDelay: 700 }],
  ['two visible enabled native Text controls are ambiguous', { ambiguousTools: true }],
  ['malformed metadata JSON', { malformed: true }],
  ['metadata exceeds the 64 KiB response cap', { oversized: true }],
  ['dashboard retains an inherited canvas before activation', { dirtyDashboard: true }],
] as const) {
  test(`qualified native identity rejects ${name}`, { timeout: 20_000 }, async t => {
    const env = await environment(t, options); if (!env) return;
    await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
    assert.equal(env.context().pages().length, 1);
    if ('dirtyDashboard' in options) assert.ok(!env.dispatched.some(url => url.includes('/api/')), 'No card activation on a dirty dashboard.');
  });
}

test('matching qualified metadata on another concurrent owned page cannot certify this opening', { timeout: 25_000 }, async t => {
  const env = await environment(t, { wrongIdentity: true, foreignPage: true }); if (!env) return;
  const rejected = assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  const betaTab = await env.browser.open('default', file(beta), beta);
  await rejected; await betaTab.check(true);
  assert.equal(env.context().pages().length, 2);
  await betaTab.close();
});

test('ambiguous exact-key cards fail before native activation', { timeout: 15_000 }, async t => {
  const env = await environment(t, { duplicates: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  assert.equal(env.context().pages().length, 1);
  assert.ok(!env.dispatched.some(url => url.includes('/api/')));
});

test('transparent native cards fail closed even with retained skeleton nodes', { timeout: 40_000 }, async t => {
  const env = await environment(t, { invisible: true }); if (!env) return;
  await assert.rejects(env.browser.open('default', file(alpha), alpha), { code: 'ui_unsupported' });
  assert.equal(env.context().pages().length, 1);
});

test('different-file SPA invalidates permanently; a failed direct reload closes the SessionManager lease', { timeout: 40_000 }, async t => {
  const env = await environment(t); if (!env) return;
  const a = await env.browser.open('default', file(alpha), alpha);
  const page = target(env.context(), alpha);
  await page.evaluate(key => { history.pushState({}, '', '/design/' + key); }, beta).catch(() => undefined);
  await until(() => page.isClosed());
  await assert.rejects(a.check(), { code: 'target_invalid' });
  const session = env.manager.createSession();
  const opened = await env.manager.open(session, 'default', file(beta), 'write');
  const lease = String(opened.lease);
  const targetId = opened.targetId;
  await assert.rejects(env.manager.execute(session, lease, false, lease => lease.tab.reload()), { code: 'site_blocked' });
  assert.ok(!env.manager.leases.has(lease));
  assert.equal(env.context().pages().length, 1);
  assert.equal(opened.targetId, targetId);
  (await env.manager.files.acquire(beta, undefined, 20))();
});

test('worker loss while identity is pending cannot publish a lease or leave a helper', { timeout: 15_000 }, async t => {
  const env = await environment(t, { slow: true }); if (!env) return;
  const opening = env.browser.open('default', file(alpha), alpha);
  const rejected = assert.rejects(opening);
  await until(() => env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
  await env.browser.stop(); env.hold(); await rejected;
  assert.equal(env.browser.workers.size, 0);
});

test('helper close failure is a composite quarantined resource, retaining writer lock and tab accounting', { timeout: 25_000 }, async t => {
  const env = await environment(t, { popup: true }); if (!env) return;
  const session = env.manager.createSession();
  const opening = env.manager.open(session, 'default', file(alpha), 'write');
  const rejected = assert.rejects(opening, { code: 'indeterminate' });
  await until(() => !!env.context()?.pages().find(page => page.url().includes('/files/recents')));
  const helper = env.context()?.pages().find(page => page.url().includes('/files/recents'))!;
  const originalClose = helper.close.bind(helper);
  helper.close = async () => { throw new Error('Synthetic unconfirmed helper closure'); };
  await rejected;
  assert.equal(env.manager.leases.size, 1);
  assert.equal([...env.manager.leases.values()][0]?.quarantined, true);
  await assert.rejects(env.manager.files.acquire(alpha, undefined, 20), /Timed out/);
  assert.ok(env.context().pages().includes(helper));
  assert.ok(!env.context().pages().some(page => page.url() === file(alpha)), 'Adopted file target was also closed.');
  helper.close = originalClose;
  await env.manager.invalidateAccount('default', true);
  assert.equal(env.manager.leases.size, 0);
  assert.equal(env.context().pages().length, 1);
  (await env.manager.files.acquire(alpha, undefined, 20))();
});

// Force the race between production routing and popup-event ownership claims.
// No browser is necessary: both calls suspend inside the same Page.opener lookup.
function pendingClaims() {
  const context = {} as BrowserContext;
  const browser = new BrowserSupervisor(new State('/synthetic-unused-state'), {
    version: 1, accounts: [{ name: 'default', loginOrigins: [] }],
  });
  type Worker = NonNullable<ReturnType<typeof browser.workers.get>>;
  const worker: Worker = { context, generation: 'synthetic-generation', stopping: false, headed: false,
    status: { account: 'default', state: 'ready', generation: 'synthetic-generation' } };
  browser.workers.set('default', worker);
  Reflect.set(browser, 'documentLoads', async () => {});
  const opener = { context: () => context } as Page;
  const opening = { worker, account: 'default', key: alpha, opener, pages: new Set([opener]),
    identified: new Set<Page>(), epochs: new Map([[opener, 0]]), readers: new Map(), cdp: new Set(), valid: true,
    phase: 'action', deadline: Date.now() + 10_000, target: undefined as Page | undefined };
  const owned = Reflect.get(browser, 'owned') as Map<Page, typeof opening>;
  owned.set(opener, opening);
  const release: (() => void)[] = [];
  const popup = () => ({ opener: () => new Promise<Page>(resolve => release.push(() => resolve(opener))),
    context: () => context, url: () => 'about:blank' } as unknown as Page);
  const claim = (page: Page) => (Reflect.get(browser, 'claimPopup') as (worker: Worker, page: Page) => Promise<boolean>).call(browser, worker, page);
  return { browser, worker, opener, opening, owned, release, popup, claim };
}

test('overlapping route and popup-event claims both authorize the exact same already-adopted page', async () => {
  const env = pendingClaims(), popup = env.popup();
  const first = env.claim(popup), second = env.claim(popup);
  assert.equal(env.release.length, 2, 'Both claims must be suspended after their initial owned lookup.');
  env.release[0]!(); assert.equal(await first, true);
  env.release[1]!(); assert.equal(await second, true);
  assert.equal(env.opening.target, popup);
  assert.deepEqual([...env.opening.pages], [env.opener, popup]);
  assert.equal(env.owned.get(popup), env.opening);
});

test('two distinct overlapping popups cannot both consume one pending opener permission', async () => {
  const env = pendingClaims(), firstPage = env.popup(), secondPage = env.popup();
  const first = env.claim(firstPage), second = env.claim(secondPage);
  assert.equal(env.release.length, 2);
  env.release[0]!(); assert.equal(await first, true);
  env.release[1]!(); assert.equal(await second, false);
  assert.equal(env.opening.target, firstPage);
  assert.equal(env.owned.has(secondPage), false);
  assert.equal(env.opening.pages.size, 2);
});

for (const loss of ['worker replacement', 'cancelled operation', 'closing operation'] as const) {
  test(`late same-page popup claims reject after ${loss} during opener lookup`, async () => {
    const env = pendingClaims(), popup = env.popup();
    const first = env.claim(popup), second = env.claim(popup);
    env.release[0]!(); assert.equal(await first, true);
    if (loss === 'worker replacement') env.browser.workers.set('default', { ...env.worker, generation: 'replacement' });
    else if (loss === 'cancelled operation') env.opening.valid = false;
    else env.opening.phase = 'closing';
    env.release[1]!(); assert.equal(await second, false);
    assert.equal(env.opening.pages.size, 2);
  });
}


// Stall only the new observer RPCs on the next owned opening. Existing leased
// pages use their original sessions, and all navigation is still real Chromium.
function heldCDP(context: BrowserContext, mode: 'enable' | 'detach' | 'attach') {
  const original = context.newCDPSession.bind(context);
  let entered = 0, detaches = 0;
  const commands: string[] = [];
  const releases: (() => void)[] = [];
  context.newCDPSession = async target => {
    const actual = await original(target);
    entered++;
    const session = new Proxy(actual, {
      get(value, field) {
        if (field === 'send') return (method: string, parameters?: unknown) => {
          commands.push(method);
          if (mode === 'enable' && method === 'Network.enable') return new Promise<never>(() => {});
          return Reflect.apply(value.send, value, [method, parameters]);
        };
        if (field === 'detach') return () => {
          detaches++;
          return mode === 'detach' ? new Promise<never>(() => {}) : actual.detach();
        };
        const result = Reflect.get(value, field);
        return typeof result === 'function' ? result.bind(value) : result;
      },
    }) as CDPSession;
    if (mode === 'attach') await new Promise<void>(resolve => releases.push(resolve));
    return session;
  };
  return { entered: () => entered, detaches: () => detaches, commands,
    release: () => releases.forEach(release => release()), restore: () => { context.newCDPSession = original; } };
}
function recoveredReservation(manager: SessionManager) {
  assert.equal(Reflect.get(manager, 'pending'), 0, 'No pending tab reservation survives confirmed cleanup.');
  assert.equal(Reflect.get(manager, 'waiters'), 0, 'Opening acquisition accounting has settled.');
}

test('CDP Network.enable deadline settles cancelled opening without touching a healthy lease', { timeout: 45_000 }, async t => {
  const env = await environment(t); if (!env) return;
  const healthySession = env.manager.createSession();
  const healthy = await env.manager.open(healthySession, 'default', file(beta), 'write');
  const healthyLease = env.manager.get(healthySession, String(healthy.lease));
  const held = heldCDP(env.context(), 'enable');
  const owner = env.manager.createSession(), started = Date.now();
  const failed = assert.rejects(env.manager.open(owner, 'default', file(alpha), 'write'), { code: 'indeterminate' });
  await until(() => held.commands.includes('Network.enable'));
  assert.equal(Reflect.get(env.manager, 'pending'), 1);
  await env.manager.closeSession(owner);
  await assert.rejects(env.manager.files.acquire(alpha, undefined, 20), /Timed out/);
  await failed;
  assert.ok(Date.now() - started <= LIMITS.operationMs + 5000, 'Setup stall settles within opening and cleanup budget.');
  held.restore(); recoveredReservation(env.manager);
  assert.equal(env.manager.leases.size, 1);
  assert.equal(env.context().pages().length, 2);
  await healthyLease.tab.check(true);
  assert.equal(env.manager.get(healthySession, String(healthy.lease)).target, healthy.targetId);
  (await env.manager.files.acquire(alpha, undefined, 20))();
  const freshOwner = env.manager.createSession();
  const fresh = await env.manager.open(freshOwner, 'default', file(alpha), 'write');
  await env.manager.release(freshOwner, String(fresh.lease));
  await healthyLease.tab.check(true);
});

test('CDP handoff detach deadline closes every owned page and restores writer and tab reservation', { timeout: 45_000 }, async t => {
  const env = await environment(t, { popup: true }); if (!env) return;
  const healthySession = env.manager.createSession();
  const healthy = await env.manager.open(healthySession, 'default', file(beta), 'write');
  const healthyLease = env.manager.get(healthySession, String(healthy.lease));
  const held = heldCDP(env.context(), 'detach');
  const ownedPages: Page[] = [];
  const record = (page: Page) => ownedPages.push(page);
  env.context().on('page', record);
  const owner = env.manager.createSession(), started = Date.now();
  await assert.rejects(env.manager.open(owner, 'default', file(alpha), 'write'), { code: 'indeterminate' });
  assert.ok(Date.now() - started <= LIMITS.operationMs + 5000);
  env.context().off('page', record); held.restore();
  assert.equal(ownedPages.length, 2, 'The operation has one dashboard and one adopted popup.');
  assert.ok(ownedPages.every(page => page.isClosed()), 'Page closure does not wait for stalled CDP detach.');
  assert.ok(held.detaches() >= 2);
  recoveredReservation(env.manager);
  assert.equal(env.manager.leases.size, 1);
  (await env.manager.files.acquire(alpha, undefined, 20))();
  await healthyLease.tab.check(true);
  const fresh = await env.manager.open(owner, 'default', file(alpha), 'write');
  await env.manager.release(owner, String(fresh.lease));
  await healthyLease.tab.check(true);
});

test('late CDP attachment after opening deadline detaches itself and cannot revive identity or consume a new opening', { timeout: 45_000 }, async t => {
  const env = await environment(t); if (!env) return;
  const owner = env.manager.createSession();
  // Ensure the context exists before installing the transport stall.
  const healthy = await env.manager.open(owner, 'default', file(beta), 'write');
  const held = heldCDP(env.context(), 'attach'), started = Date.now();
  const failed = assert.rejects(env.manager.open(owner, 'default', file(alpha), 'write'), { code: 'indeterminate' });
  await until(() => held.entered() === 1);
  await failed;
  assert.ok(Date.now() - started <= LIMITS.operationMs + 5000);
  assert.equal(held.commands.length, 0);
  assert.equal(held.detaches(), 0, 'Session handle has not been returned to the supervisor yet.');
  held.restore(); held.release();
  await until(() => held.detaches() === 1);
  assert.equal(held.commands.length, 0, 'Expired late attachment cannot start an identity observer.');
  recoveredReservation(env.manager);
  assert.equal(env.manager.leases.size, 1);
  await env.manager.get(owner, String(healthy.lease)).tab.check(true);
  const fresh = await env.manager.open(owner, 'default', file(alpha), 'write');
  assert.equal(env.manager.leases.size, 2);
  await env.manager.release(owner, String(fresh.lease));
  await env.manager.get(owner, String(healthy.lease)).tab.check(true);
});

test('CDP timeout quarantine keeps an unconfirmed target and writer until explicit confirmed closure', { timeout: 45_000 }, async t => {
  const env = await environment(t, { popup: true }); if (!env) return;
  const owner = env.manager.createSession();
  const healthy = await env.manager.open(owner, 'default', file(beta), 'write');
  const held = heldCDP(env.context(), 'detach');
  const ownedPages: Page[] = [], restoreClose: (() => void)[] = [];
  const record = (page: Page) => {
    ownedPages.push(page);
    const original = page.close.bind(page);
    page.close = async options => {
      if (page.url() === file(alpha)) throw new Error('Synthetic unconfirmed closure after CDP timeout');
      return original(options);
    };
    restoreClose.push(() => { page.close = original; });
  };
  env.context().on('page', record);
  const started = Date.now();
  await assert.rejects(env.manager.open(owner, 'default', file(alpha), 'write'), { code: 'indeterminate' });
  assert.ok(Date.now() - started <= LIMITS.operationMs + 5000);
  env.context().off('page', record); held.restore();
  recoveredReservation(env.manager);
  assert.equal(ownedPages.length, 2);
  assert.equal(ownedPages.filter(page => page.isClosed()).length, 1, 'Helper is closed; the unconfirmed target remains tracked.');
  const quarantine = [...env.manager.leases.values()].find(lease => lease.fileKey === alpha);
  assert.ok(quarantine?.quarantined);
  assert.equal(env.manager.leases.size, 2, 'Quarantine retains one capacity slot alongside the healthy lease.');
  await assert.rejects(env.manager.files.acquire(alpha, undefined, 20), /Timed out/);
  await env.manager.get(owner, String(healthy.lease)).tab.check(true);
  restoreClose.forEach(restore => restore());
  quarantine.closing = undefined;
  await env.manager.closeLease(quarantine);
  assert.ok(ownedPages.every(page => page.isClosed()));
  assert.equal(env.manager.leases.size, 1);
  (await env.manager.files.acquire(alpha, undefined, 20))();
  await env.manager.get(owner, String(healthy.lease)).tab.check(true);
  const fresh = await env.manager.open(owner, 'default', file(alpha), 'write');
  await env.manager.release(owner, String(fresh.lease));
});


test('blocked dashboard iframe error document preserves the requested native opening while external dispatch stays denied', { timeout: 20_000 }, async t => {
  const env = await environment(t, { dashboardBlockedFrame: true }); if (!env) return;
  const session = env.manager.createSession();
  const opened = await env.manager.open(session, 'default', file(alpha), 'write');
  assert.ok(env.blockedChildErrorDocuments.includes(true), 'Chromium really committed the aborted child frame error document before cards appeared.');
  assert.ok(!env.dispatched.includes('https://external.invalid/blocked-dashboard-frame'), 'The external document was denied before dispatch.');
  const lease = env.manager.get(session, String(opened.lease));
  await lease.tab.check(true);
  assert.equal(target(env.context(), alpha).url(), file(alpha));
  assert.equal(env.manager.leases.size, 1);
  await env.manager.release(session, String(opened.lease));
  assert.equal(env.context().pages().length, 1);
  (await env.manager.files.acquire(alpha, undefined, 20))();
});

test('uncorrelated child error document still invalidates the leased target and another file remains healthy', { timeout: 20_000 }, async t => {
  const env = await environment(t); if (!env) return;
  const [a,b] = await Promise.all([env.browser.open('default',file(alpha),alpha),env.browser.open('default',file(beta),beta)]);
  const page=target(env.context(),alpha);
  // A frame commit without a preceding rejected request must not consume the exception.
  const emit=Reflect.get(page,'emit') as (name:string, frame: unknown)=>boolean;
  emit.call(page,'framenavigated',{url:()=> 'chrome-error://chromewebdata/'});
  await until(()=>page.isClosed());
  await assert.rejects(a.check(),{code:'target_invalid'});
  await b.check(true); await b.close();
  assert.equal(env.context().pages().length,1);
});

test('blocked frame recovery never permits an external main-frame document', { timeout: 20_000 }, async t => {
  const env = await environment(t,{dashboardBlockedFrame:true}); if (!env) return;
  const tab=await env.browser.open('default',file(alpha),alpha);
  const page=target(env.context(),alpha);
  await assert.rejects(page.goto('https://external.invalid/forbidden-main-frame'));
  await until(()=>page.isClosed());
  assert.ok(!env.dispatched.includes('https://external.invalid/forbidden-main-frame'));
  await assert.rejects(tab.check(),{code:'target_invalid'});
});


test('fresh exact metadata survives unrelated inspector response pressure during loader validation', { timeout: 20_000 }, async t => {
  const env = await environment(t, { metadataPressure: true }); if (!env) return;
  const owner = env.manager.createSession();
  let opened: Record<string, unknown>;
  try { opened = await env.manager.open(owner, 'default', file(alpha), 'write'); }
  catch (error) {
    assert.fail('Fresh requested metadata could not qualify: ' + JSON.stringify({
      code: Reflect.get(error as object, 'code'), bodyErrors: env.metadataBodyErrors, pressureResponses: env.pressureResponses(),
    }));
  }
  assert.equal(env.pressureResponses(), 8, 'Eight real bounded unrelated responses complete before metadata retrieval.');
  assert.deepEqual(env.metadataBodyErrors, [], 'The qualified tiny metadata body stays retrievable.');
  await env.manager.get(owner, String(opened.lease)).tab.check(true);
  await env.manager.release(owner, String(opened.lease));
  recoveredReservation(env.manager);
  assert.equal(env.context().pages().length, 1);
});

for (const [name, options] of [
  ['wrong current document loader', { wrongLoader: true }],
  ['cached metadata request', { cachedMetadata: true }],
] as const) {
  test('inspector body retention still rejects ' + name, { timeout: 20_000 }, async t => {
    const env = await environment(t, options); if (!env) return;
    const owner = env.manager.createSession();
    await assert.rejects(env.manager.open(owner, 'default', file(alpha), 'write'), { code: 'ui_unsupported' });
    assert.ok(env.dispatched.some(url => url.endsWith('/api/file_metadata/' + alpha)));
    recoveredReservation(env.manager);
    assert.equal(env.manager.leases.size, 0);
    assert.equal(env.context().pages().length, 1);
    const unlock = await env.manager.files.acquire(alpha, undefined, 100); unlock();
  });
}
