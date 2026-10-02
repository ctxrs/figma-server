import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page, type FileChooser, type ElementHandle, type Request, type Response, type CDPSession, type Frame } from 'playwright';
import { type Config, State, privateDirectory } from './state.js';
import { LIMITS, fileUrl, figmaOrigin, permittedNavigation, sameFile, modifierKeys, type Modifier, type ImagePayload, type Expectation, type LocatorSpec } from './security.js';
import { Fault, fault } from './errors.js';
import { bounded } from './scheduler.js';
import { inspection, locate, pasteHtml, probe, readValue, requireEditing, verify, type Readiness, type Verification } from './figma-adapter.js';

export interface BrowserTab {
  readonly target: string;
  readonly generation: string;
  close(): Promise<void>;
  check(write?: boolean): Promise<void>;
  inspect(): Promise<Record<string, unknown>>;
  readValue(locator: LocatorSpec): Promise<string>;
  reload(): Promise<void>;
  screenshot(scope?: LocatorSpec): Promise<Buffer>;
  click(locator: LocatorSpec, modifiers?: Modifier[]): Promise<void>;
  pointerClick(point: { x: number; y: number }, clicks: 1 | 2, button: 'left' | 'right', modifiers?: Modifier[]): Promise<void>;
  typeText(text: string): Promise<void>;
  wheel(point: { x: number; y: number }, deltaX: number, deltaY: number): Promise<void>;
  fill(locator: LocatorSpec, text: string): Promise<void>;
  keypress(keys: string): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, modifiers?: Modifier[]): Promise<void>;
  uploadImage?(image: ImagePayload, trigger: LocatorSpec, signal?: AbortSignal): Promise<void>;
  paste(html: string, target?: LocatorSpec): Promise<void>;
  verify(expectation?: Expectation): Promise<Verification>;
  metrics(): Promise<Record<string, number>>;
}
export type AccountStatus = { account: string; state: Readiness | 'stopped' | 'starting' | 'authorizing'; generation?: string };
export interface BrowserBackend {
  status(account: string): AccountStatus;
  open(account: string, url: string, fileKey: string): Promise<BrowserTab>;
  start(): Promise<void>;
  stop(): Promise<void>;
  login(account: string, confirm: () => Promise<void>): Promise<AccountStatus>;
  onCrash?: (account: string) => void;
}
export class BrowserOpenFailure extends Fault {
  constructor(readonly tab: BrowserTab) {
    super('indeterminate', 'An opening target could not be confirmed closed; its file must remain quarantined.', 409);
  }
}

export function browserEnvironment(state: State): Record<string, string> {
  const env: Record<string, string> = {};
  // Explicit allowlist: no inherited cloud/API/daemon credentials in browser subprocesses.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = state.root;
  env.USERPROFILE = state.root;
  return env;
}

type Worker = { context: BrowserContext; generation: string; stopping: boolean; status: AccountStatus; headed: boolean };
type Opening = {
  worker: Worker; account: string; key: string; opener: Page; target?: Page;
  pages: Set<Page>; identified: Set<Page>; metadata: Map<Page, { key: string; name: string; epoch: number }>; epochs: Map<Page, number>; readers: Map<Page, Promise<void>>; cdp: Set<CDPSession>; actionTime?: Promise<number>; valid: boolean; deadline: number;
  phase: 'direct' | 'dashboard' | 'action' | 'leased' | 'closing';
};
const dashboardUrl = 'https://www.figma.com/files/recents';
function dashboardNavigation(input: string): boolean {
  try {
    const url = new URL(input);
    return permittedNavigation(input) && /^\/(?:files|drafts)(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

// Fixed, read-only card metadata paths. No React stores, callbacks or account data.
function nativeCardMatches(node: Node, key: string): boolean {
  if (!(node instanceof HTMLButtonElement) || node.disabled || node.getAttribute('aria-disabled') === 'true'
      || !node.isConnected || !node.closest('[role="listitem"]')) return false;
  const box = node.getBoundingClientRect();
  if (box.width < 80 || box.height < 45 || box.width > 650 || box.height > 600
      || box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
  }
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  if (!hit || !node.contains(hit)) return false;
  const own = (value: unknown, field: string): unknown => value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, field)?.value : undefined;
  const matches = (props: unknown): boolean => {
    const paths = [['item', 'file', 'key'], ['tile', 'file', 'key'], ['bottomRightContent', 'props', 'tile', 'file', 'key']];
    return paths.some(path => path.reduce<unknown>((value, field) => own(value, field), props) === key);
  };
  for (const field of Object.getOwnPropertyNames(node)) {
    if (!field.startsWith('__reactFiber$')) continue;
    let fiber = own(node, field);
    for (let depth = 0; fiber && depth < 16; depth++, fiber = own(fiber, 'return')) {
      if (matches(own(fiber, 'memoizedProps'))) return true;
    }
  }
  return false;
}
function renderedNativeButton(node: Node): boolean {
  if (!(node instanceof HTMLButtonElement) || !node.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
  }
  return true;
}
async function nativeButton(page: Page, id: 'Text-tool' | 'Frame-tool' | 'filename'): Promise<ElementHandle<Node> | undefined> {
  const buttons = await page.getByTestId(id).elementHandles();
  const rendered: ElementHandle<Node>[] = [];
  for (const button of buttons) {
    if (await button.evaluate(renderedNativeButton)) rendered.push(button);
    else await button.dispose();
  }
  if (rendered.length === 1) return rendered[0];
  await Promise.all(rendered.map(button => button.dispose()));
  return undefined;
}
async function filenameMatches(page: Page, name: string): Promise<boolean> {
  const button = await nativeButton(page, 'filename');
  if (!button) return false;
  try { return await button.evaluate((node, expected) => (node as HTMLElement).innerText.trim() === expected, name); }
  finally { await button.dispose(); }
}
async function nativeEditorReady(page: Page): Promise<boolean> {
  const canvas = await page.locator('canvas').evaluateAll(nodes => nodes.some(node => {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
    }
    return true;
  }));
  if (!canvas) return false;
  const text = await nativeButton(page, 'Text-tool'), frame = await nativeButton(page, 'Frame-tool');
  const ready = Boolean(text && frame);
  await text?.dispose(); await frame?.dispose();
  return ready;
}
async function editorReadiness(page: Page, key: string): Promise<Readiness> {
  const state = await probe(page, key);
  return state === 'ui_unsupported' && sameFile(page.url(), key) && await nativeEditorReady(page) ? 'ready' : state;
}
export class BrowserSupervisor implements BrowserBackend {
  readonly workers = new Map<string, Worker>();
  private readonly owned = new Map<Page, Opening>();
  private readonly blockedFrames = new WeakMap<Frame, { opening: Opening; epoch: number }>();
  private readonly started = new WeakMap<Request, { opening: Opening; page: Page; epoch: number; at: number }>();
  readonly states = new Map<string, AccountStatus>();
  private readonly starting = new Map<string, Promise<Worker>>();
  onCrash?: (account: string) => void;
  constructor(readonly state: State, readonly config: Config,
    private readonly launchBrowser: typeof chromium.launchPersistentContext = chromium.launchPersistentContext.bind(chromium)) {
    for (const account of config.accounts) this.states.set(account.name, { account: account.name, state: 'stopped' });
  }
  status(account: string): AccountStatus {
    const value = this.states.get(account);
    if (!value) fault('unknown_account', 'Account is not configured.', 404);
    return { ...value };
  }
  async start(): Promise<void> {
    for (const account of this.config.accounts) {
      const worker = await this.ensure(account.name);
      if (account.probeUrl) {
        try {
          const { expectedKey } = await import('./figma-adapter.js');
          const tab = await this.open(account.name, account.probeUrl, expectedKey(account.probeUrl));
          await tab.close();
        } catch { /* The precise probe state is set by open; startup can serve needs_login. */ }
      } else await this.dashboard(worker);
    }
  }
  private set(worker: Worker, state: AccountStatus['state']): void {
    worker.status = { ...worker.status, state };
    this.states.set(worker.status.account, worker.status);
  }
  private async dashboard(worker: Worker): Promise<void> {
    const page = await worker.context.newPage();
    try {
      const response = await page.goto('https://www.figma.com/files/recents', { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400 && response.status() !== 401) { this.set(worker, 'site_blocked'); return; }
      this.set(worker, await this.waitProbe(page));
    } catch { this.set(worker, 'network_error'); }
    finally { await page.close().catch(() => undefined); }
  }
  private async waitProbe(page: Page, key?: string): Promise<Readiness> {
    const until = Date.now() + 15_000;
    let readiness = await probe(page, key);
    while (readiness === 'ui_unsupported' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 250));
      readiness = await probe(page, key);
    }
    return readiness;
  }
  private async ensure(account: string, headed = false): Promise<Worker> {
    this.status(account);
    const existing = this.workers.get(account);
    if (existing) {
      if (existing.headed !== headed) fault('account_busy', 'Account is in a different browser mode.', 409);
      return existing;
    }
    const pending = this.starting.get(account);
    if (pending) return pending;
    const promise = this.launch(account, headed);
    this.starting.set(account, promise);
    try { return await promise; } finally { this.starting.delete(account); }
  }
  private async launch(account: string, headed: boolean): Promise<Worker> {
    const profile = this.state.path('accounts', account, 'profile');
    await privateDirectory(profile);
    this.states.set(account, { account, state: headed ? 'authorizing' : 'starting' });
    try {
      const executablePath = this.config.browser ?? chromium.executablePath();
      await access(executablePath);
      const context = await this.launchBrowser(profile, {
        executablePath, channel: 'chromium', headless: !headed, chromiumSandbox: true,
        viewport: { width: 1920, height: 1200 }, acceptDownloads: false,
        serviceWorkers: 'block', timeout: LIMITS.operationMs,
        env: browserEnvironment(this.state),
        args: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-sync', '--no-first-run'],
      });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(20_000);
      const worker: Worker = { context, generation: randomUUID(), stopping: false,
        status: { account, state: headed ? 'authorizing' : 'needs_login' }, headed };
      worker.status.generation = worker.generation;
      this.workers.set(account, worker);
      this.states.set(account, worker.status);
      // Block unsafe redirects before network dispatch, including child-frame navigations.
      const extra = headed ? this.config.accounts.find(a => a.name === account)?.loginOrigins ?? [] : [];
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          if (headed) {
            if (!permittedNavigation(request.url(), extra)) await route.abort('blockedbyclient');
            else await route.fallback();
            return;
          }
          let page: Page;
          try { page = request.frame().page(); }
          catch { await route.abort('blockedbyclient'); return; } // Uncorrelatable early popup navigation.
          let allowed = permittedNavigation(request.url(), extra);
          if (!headed) {
            if (await page.opener()) allowed = allowed && await this.claimPopup(worker, page);
            const opening = this.owned.get(page);
            if (opening && request.frame() === page.mainFrame()) allowed = allowed && this.navigationAllowed(opening, page, request.url());
          }
          if (!allowed) {
            const opening = this.owned.get(page);
            if (opening) {
              if (request.frame() === page.mainFrame()) this.invalidate(opening);
              else this.blockedFrames.set(request.frame(), { opening, epoch: opening.epochs.get(page) ?? 0 });
            }
            await route.abort('blockedbyclient'); return;
          }
        }
        await route.fallback();
      });
      context.on('page', page => {
        if (!headed) {
          page.on('popup', popup => {
            void this.claimPopup(worker, popup).then(allowed => {
              if (!allowed) return popup.close();
            }).catch(() => undefined);
          });
          page.on('framenavigated', frame => {
            const opening = this.owned.get(page);
            if (!opening) return;
            if (frame === page.mainFrame()) {
              if (!this.navigationAllowed(opening, page, frame.url())) this.invalidate(opening);
            } else {
              const rejected = this.blockedFrames.get(frame);
              this.blockedFrames.delete(frame);
              // Chromium commits an internal error document after an aborted iframe
              // request. Only that same frame and opening epoch may retain the page.
              if (frame.url() === 'chrome-error://chromewebdata/' && rejected?.opening === opening
                  && rejected.epoch === opening.epochs.get(page)) return;
              if (!permittedNavigation(frame.url()) && frame.url() !== 'about:blank') this.invalidate(opening);
            }
          });
          page.on('crash', () => { const opening = this.owned.get(page); if (opening) this.invalidate(opening); });
          page.on('close', () => {
            const opening = this.owned.get(page);
            if (opening && opening.phase !== 'closing' && (page === opening.target || page === opening.opener && !opening.target)) opening.valid = false;
            this.owned.delete(page);
          });
        } else page.on('framenavigated', frame => {
          if (!permittedNavigation(frame.url(), extra)) void page.close().catch(() => undefined);
        });
        page.on('download', download => { void download.cancel().catch(() => undefined); });
      });
      context.on('request', request => {
        try {
          const frame = request.frame(), page = frame.page();
          const opening = this.owned.get(page);
          if (!opening || frame !== page.mainFrame()) return;
          if (request.isNavigationRequest()) {
            opening.identified.delete(page);
            opening.metadata.delete(page);
            opening.epochs.set(page, (opening.epochs.get(page) ?? 0) + 1);
          }
          if (this.live(opening) && (request.isNavigationRequest() || opening.phase === 'action')) {
            this.started.set(request, { opening, page, epoch: opening.epochs.get(page) ?? 0, at: request.timing().startTime });
          }
        } catch { /* Early popup requests have no attributable frame and are denied by the route. */ }
      });
      context.on('response', response => { void this.observeResponse(response); });
      context.on('close', () => {
        for (const opening of this.owned.values()) if (opening.worker === worker) opening.valid = false;
        for (const [page, opening] of this.owned) if (opening.worker === worker) this.owned.delete(page);
        this.workers.delete(account);
        this.set(worker, worker.stopping ? 'stopped' : 'crashed');
        if (!worker.stopping) this.onCrash?.(account);
      });
      // Keep the browser-owned blank tab. Closing a headed Chromium's last
      // window can terminate its persistent context before login creates a page.
      // It never receives an agent lease.
      return worker;
    } catch {
      this.states.set(account, { account, state: 'crashed' });
      fault('browser_start_failed', 'Chromium could not start. Run doctor; keep the sandbox enabled.', 503);
    }
  }
  private documentLoads(opening: Opening, page: Page): Promise<void> {
    const existing = opening.readers.get(page);
    if (existing) return existing;
    const pending = (async () => {
      const cdp = await opening.worker.context.newCDPSession(page);
      if (!this.live(opening) || this.owned.get(page) !== opening) { void cdp.detach().catch(() => undefined); return; }
      opening.cdp.add(cdp);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      if (!this.live(opening) || this.owned.get(page) !== opening) { void cdp.detach().catch(() => undefined); return; }
      const frameId = frameTree.frame.id;
      type Load = { at: number; epoch: number; loader: string; ok: boolean; cached: boolean };
      const loads = new Map<string, Load>();
      let overflow = false;
      cdp.on('Network.requestWillBeSent', event => {
        try {
          if (event.redirectResponse) { loads.delete(event.requestId); return; }
          const url = new URL(event.request.url);
          if (event.frameId !== frameId || event.request.method !== 'GET' || url.origin !== figmaOrigin
              || url.pathname !== `/api/file_metadata/${opening.key}` || url.search
              || opening.phase !== 'action' || !this.live(opening)) return;
          if (loads.size >= 4) { overflow = true; return; }
          loads.set(event.requestId, { at: event.wallTime * 1000, epoch: opening.epochs.get(page) ?? 0,
            loader: event.loaderId, ok: false, cached: false });
        } catch { /* Unqualified requests are never read. */ }
      });
      cdp.on('Network.requestServedFromCache', event => { const load = loads.get(event.requestId); if (load) load.cached = true; });
      cdp.on('Network.responseReceived', event => {
        const load = loads.get(event.requestId);
        if (!load) return;
        try {
          const url = new URL(event.response.url);
          load.ok = url.origin === figmaOrigin && url.pathname === `/api/file_metadata/${opening.key}` && !url.search
            && event.frameId === frameId && event.response.status === 200
            && event.response.mimeType === 'application/json' && !event.response.fromDiskCache && !event.response.fromServiceWorker;
        } catch { load.ok = false; }
      });
      cdp.on('Network.loadingFailed', event => { loads.delete(event.requestId); });
      cdp.on('Network.loadingFinished', event => {
        const load = loads.get(event.requestId);
        if (!load) return;
        void (async () => {
          const current = () => !overflow && load.ok && !load.cached && this.live(opening)
            && this.owned.get(page) === opening && opening.phase === 'action'
            && opening.epochs.get(page) === load.epoch && sameFile(page.url(), opening.key)
            && (!opening.target || opening.target === page);
          if (!current() || !opening.actionTime || event.encodedDataLength > 65536) return;
          const actionAt = await opening.actionTime;
          if (!Number.isFinite(actionAt) || !Number.isFinite(load.at) || load.at < actionAt || !current()) return;
          const tree = await cdp.send('Page.getFrameTree');
          if (tree.frameTree.frame.id !== frameId || tree.frameTree.frame.loaderId !== load.loader || !current()) return;
          const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
          const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
          if (bytes.length > 65536 || !current()) return;
          const payload = JSON.parse(bytes.toString('utf8')) as { meta?: { file_key?: unknown; name?: unknown } };
          if (payload?.meta?.file_key !== opening.key || typeof payload.meta.name !== 'string'
              || !payload.meta.name || payload.meta.name.length > 1024) return;
          // Metadata normally arrives before the editor renders. Retain only typed
          // identity fields for this document epoch, never the response body.
          if (current()) opening.metadata.set(page, { key: opening.key, name: payload.meta.name, epoch: load.epoch });
        })().catch(() => undefined).finally(() => loads.delete(event.requestId));
      });
      // Other responses share this pool while the metadata loader is checked.
      // Keep each response and the parsed identity body bounded to 64 KiB.
      await cdp.send('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 65536, maxPostDataSize: 0 });
    })();
    opening.readers.set(page, pending);
    return pending;
  }
  private async observeResponse(response: Response): Promise<void> {
    try {
      const request = response.request(), frame = request.frame(), page = frame.page();
      const opening = this.owned.get(page);
      if (!opening || !this.live(opening) || frame !== page.mainFrame()
          || response.status() < 200 || response.status() >= 300) return;
      const started = this.started.get(request);
      if (!started || started.opening !== opening || started.page !== page
          || started.epoch !== opening.epochs.get(page)) return;
      // Preserve successful direct navigation/reload semantics; native popup documents
      // are not sufficient evidence for a card-triggered opening.
      if (['direct', 'leased'].includes(opening.phase) && request.isNavigationRequest()
          && sameFile(response.url(), opening.key)) {
        opening.identified.add(page); return;
      }
    } catch { /* Detached, unqualified or malformed data cannot establish identity. */ }
  }
  private live(opening: Opening): boolean {
    return opening.valid && !opening.worker.stopping && this.workers.get(opening.account) === opening.worker
      && (opening.phase === 'leased' || Date.now() < opening.deadline);
  }
  private navigationAllowed(opening: Opening, page: Page, url: string): boolean {
    if (!this.live(opening) || opening.phase === 'closing') return false;
    if (url === 'about:blank') return opening.phase === 'action' && page === opening.target;
    if (sameFile(url, opening.key)) return opening.phase !== 'dashboard' && (!opening.target || opening.target === page);
    return page === opening.opener && ['dashboard', 'action'].includes(opening.phase) && dashboardNavigation(url);
  }
  private invalidate(opening: Opening): void {
    opening.valid = false;
    for (const page of opening.pages) void page.close().catch(() => undefined);
  }
  private async claimPopup(worker: Worker, page: Page): Promise<boolean> {
    const existing = this.owned.get(page);
    if (existing) return existing.worker === worker && this.live(existing)
      && page === existing.target && ['action', 'leased'].includes(existing.phase);
    const opener = await page.opener();
    // Routing and popup events may await the same opener lookup concurrently.
    // The other claim can have adopted this exact page while this call was suspended.
    const adopted = this.owned.get(page);
    if (adopted) return adopted.worker === worker && this.live(adopted)
      && page === adopted.target && ['action', 'leased'].includes(adopted.phase);
    const opening = opener ? this.owned.get(opener) : undefined;
    if (!opening || opening.worker !== worker || opening.worker.context !== page.context()
        || !this.live(opening) || opening.phase !== 'action' || opening.target || opener !== opening.opener
        || page.url() !== 'about:blank' && !sameFile(page.url(), opening.key)) return false;
    opening.target = page;
    opening.pages.add(page);
    opening.epochs.set(page, 0);
    this.owned.set(page, opening);
    void this.documentLoads(opening, page).catch(() => undefined);
    return true;
  }
  private async card(page: Page, key: string, deadline: number): Promise<ElementHandle<Node> | undefined> {
    while (Date.now() < deadline && !page.isClosed()) {
      const buttons = await page.locator('[role="listitem"] button').elementHandles();
      if (buttons.length > 256) {
        await Promise.all(buttons.map(button => button.dispose()));
        fault('ui_unsupported', 'The rendered native card listing exceeds the bounded inspection limit.', 409);
      }
      const matches: ElementHandle<Node>[] = [];
      for (const button of buttons) {
        if (await button.evaluate(nativeCardMatches, key)) matches.push(button);
        else await button.dispose();
      }
      if (matches.length === 1) return matches[0];
      for (const button of matches) await button.dispose();
      if (matches.length > 1) fault('ui_unsupported', 'The requested native card action is ambiguous.', 409);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return undefined;
  }
  async open(account: string, input: string, fileKey: string): Promise<BrowserTab> {
    const file = fileUrl(input);
    if (file.fileKey !== fileKey) fault('invalid_file', 'Requested URL and file key disagree.');
    if (this.status(account).state === 'authorizing') fault('account_busy', 'Account login is in progress.', 409);
    if (this.status(account).state === 'crashed') fault('browser_crashed', 'Restart or log in to recover the account.', 503);
    const worker = await this.ensure(account);
    const page = await worker.context.newPage();
    const opening: Opening = { worker, account, key: fileKey, opener: page, pages: new Set([page]),
      identified: new Set(), metadata: new Map(), epochs: new Map([[page, 0]]), readers: new Map(), cdp: new Set(), valid: true, phase: 'direct', deadline: Date.now() + LIMITS.operationMs };
    this.owned.set(page, opening);
    const remaining = () => Math.max(1, opening.deadline - Date.now());
    const close = async () => {
      opening.valid = false; opening.phase = 'closing';
      // All closes are attempted, and confirmation covers every owned resource.
      void Promise.allSettled([...opening.cdp].map(cdp => cdp.detach()));
      const results = await Promise.allSettled([...opening.pages].map(p => p.isClosed() ? Promise.resolve() : p.close()));
      if (results.some(result => result.status === 'rejected') || [...opening.pages].some(p => !p.isClosed())) {
        fault('indeterminate', 'Opening resources could not all be confirmed closed.', 409);
      }
    };
    const makeTab = (target: Page) => new PlaywrightTab(target, worker.context, fileKey, worker.generation,
      () => this.live(opening) && opening.target === target && opening.identified.has(target), close);
    let tab = makeTab(page);
    try {
      const response = await page.goto(file.url, { waitUntil: 'domcontentloaded', timeout: Math.min(10_000, remaining()) });
      if (response?.status() === 403) {
        // Selection requires normal editor navigation not yet supported by this fallback.
        if (new URL(file.url).search) fault('ui_unsupported', 'Native dashboard opening does not yet support node/page selection.', 409);
        if (!['file', 'design'].includes(new URL(file.url).pathname.split('/')[1]!)) {
          fault('ui_unsupported', 'Native dashboard opening is qualified only for file/design cards.', 409);
        }
        opening.phase = 'dashboard'; opening.identified.clear();
        const dashboard = await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(10_000, remaining()) });
        if (dashboard && dashboard.status() >= 400) fault('site_blocked', 'The normal dashboard returned an HTTP error.', 503);
        const readiness = await probe(page);
        if (['needs_login', 'permission_denied', 'consent_required'].includes(readiness)) fault(readiness, 'The normal dashboard requires user action.', 409);
        const drafts = page.getByRole('button', { name: 'Drafts', exact: true });
        await drafts.waitFor({ state: 'visible', timeout: Math.min(15_000, remaining()) });
        let card = await this.card(page, fileKey, Math.min(opening.deadline - 1500, Date.now() + 1500));
        if (!card) {
          await drafts.click({ timeout: Math.min(5000, remaining()) });
          await page.getByRole('heading', { name: 'Drafts', exact: true }).waitFor({ state: 'visible', timeout: Math.min(5000, remaining()) });
          card = await this.card(page, fileKey, opening.deadline - 1500);
        }
        if (!card) fault('ui_unsupported', 'The requested existing file has no exact rendered native card in Recents or Drafts.', 409);
        try {
          if (!this.live(opening) || !await card.evaluate(nativeCardMatches, fileKey)) fault('ui_unsupported', 'The requested native card changed before activation.', 409);
          if (!dashboardNavigation(page.url()) || await page.locator('canvas').count() !== 0) {
            fault('ui_unsupported', 'Native opening requires a fresh dashboard without an inherited editor.', 409);
          }
          const oldText = await nativeButton(page, 'Text-tool'), oldFrame = await nativeButton(page, 'Frame-tool');
          if (oldText || oldFrame) {
            await oldText?.dispose(); await oldFrame?.dispose();
            fault('ui_unsupported', 'Native opening requires a dashboard without native editor controls.', 409);
          }
          await bounded(this.documentLoads(opening, page), undefined, remaining());
          // Capture the actual trusted card activation, not the start of Playwright's
          // actionability wait. Requests initiated before this event cannot certify it.
          const observer = await card.evaluateHandle(node => {
            const time = new Promise<number>(resolve => {
              node.addEventListener('dblclick', event => resolve(event.isTrusted
                ? performance.timeOrigin + event.timeStamp : Number.POSITIVE_INFINITY), { once: true, capture: true });
            });
            return { time };
          });
          opening.actionTime = observer.evaluate(value => value.time);
          void opening.actionTime.catch(() => undefined);
          opening.phase = 'action'; // Permission is registered before the normal native action.
          try { await card.dblclick({ timeout: Math.min(5000, remaining()) }); }
          finally { await observer.dispose(); }
        } finally { await card.dispose(); }
      } else if (response && response.status() >= 400 && response.status() !== 401) {
        this.set(worker, 'site_blocked');
        fault('site_blocked', 'The site returned an HTTP error; this does not prove a missing login.', 503);
      }
      const identityDeadline = Math.min(opening.deadline, Date.now() + 10_000);
      let state: Readiness = 'ui_unsupported';
      while (this.live(opening) && Date.now() < identityDeadline) {
        if (!opening.target && sameFile(page.url(), fileKey) && opening.phase !== 'dashboard') opening.target = page;
        const target = opening.target;
        if (target && !target.isClosed() && target.url() !== 'about:blank') {
          state = await editorReadiness(target, fileKey);
          const identity = opening.metadata.get(target);
          if (opening.phase === 'action' && state === 'ready' && identity?.key === fileKey
              && identity.epoch === opening.epochs.get(target) && await filenameMatches(target, identity.name)
              && await nativeEditorReady(target) && this.live(opening) && opening.metadata.get(target) === identity
              && identity.epoch === opening.epochs.get(target)) opening.identified.add(target);
          if (state === 'ready' && opening.identified.has(target)) break;
          if (!['ready', 'ui_unsupported'].includes(state)) break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const target = opening.target;
      if (state !== 'ready' || !target || !this.live(opening) || !opening.identified.has(target)) {
        fault(state === 'ready' ? 'ui_unsupported' : state, 'Requested document identity and editor readiness could not be confirmed; native document-load qualification is required.', 409);
      }
      tab = makeTab(target);
      if (target !== page) {
        const { bounded } = await import('./scheduler.js');
        await bounded(page.close(), undefined, 5000);
        if (!page.isClosed()) fault('indeterminate', 'Dashboard helper closure could not be confirmed.', 409);
      }
      await bounded(Promise.allSettled([...opening.readers.values()]), undefined, remaining());
      await bounded(Promise.allSettled([...opening.cdp].map(cdp => cdp.detach())), undefined, remaining());
      opening.cdp.clear();
      if (opening.phase === 'action') {
        const identity = opening.metadata.get(target);
        if (!identity || identity.epoch !== opening.epochs.get(target)
            || !await filenameMatches(target, identity.name) || !await nativeEditorReady(target)) {
          fault('ui_unsupported', 'Native document identity changed before lease publication.', 409);
        }
        opening.metadata.clear();
      }
      if (!this.live(opening)) fault('target_invalid', 'Opening expired or lost its worker before handoff.', 409);
      opening.phase = 'leased';
      await tab.check();
      if (!this.live(opening)) fault('target_invalid', 'Opening worker generation was lost.', 409);
      this.set(worker, 'ready');
      return tab;
    } catch (error) {
      const { bounded } = await import('./scheduler.js');
      try { await bounded(close(), undefined, 5000); }
      catch { throw new BrowserOpenFailure(tab); }
      if (!(error instanceof Fault)) {
        fault(error instanceof Error && error.name === 'TimeoutError' ? 'ui_unsupported' : 'network_error', 'Figma opening failed before requested editor readiness.', 409);
      }
      throw error;
    } finally {
      // A leased target keeps lifetime guards; every other pending permission is revoked.
      if (opening.phase !== 'leased') opening.valid = false;
    }
  }
  async login(account: string, confirm: () => Promise<void>): Promise<AccountStatus> {
    const setting = this.config.accounts.find(a => a.name === account);
    if (!setting) fault('unknown_account', 'Account is not configured.', 404);
    await this.stopAccount(account);
    const worker = await this.ensure(account, true);
    let failure: unknown;
    try {
      const page = worker.context.pages()[0] ?? await worker.context.newPage();
      await page.goto('https://www.figma.com/login', { waitUntil: 'domcontentloaded' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([confirm(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Fault('login_timeout', 'Login timed out; run login again to retry.', 409)), LIMITS.loginMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      const { expectedKey } = await import('./figma-adapter.js');
      await page.goto(setting.probeUrl ?? 'https://www.figma.com/files/recents', { waitUntil: 'domcontentloaded' });
      const readiness = await this.waitProbe(page, setting.probeUrl ? expectedKey(setting.probeUrl) : undefined);
      if (readiness !== 'ready' && readiness !== 'authenticated_unverified') fault(readiness, 'Login did not establish an observable Figma session.', 409);
    } catch (error) { failure = error; }
    finally { await this.stopAccount(account); }
    // Prove persistence by reopening the profile headlessly after closing the headed process.
    const { expectedKey } = await import('./figma-adapter.js');
    if (setting.probeUrl && !failure) {
      const tab = await this.open(account, setting.probeUrl, expectedKey(setting.probeUrl));
      await tab.close();
    } else await this.dashboard(await this.ensure(account));
    if (failure) throw failure;
    return this.status(account);
  }
  async stopAccount(account: string): Promise<void> {
    const worker = this.workers.get(account);
    if (worker) { worker.stopping = true; await worker.context.close(); }
  }
  async stop(): Promise<void> {
    await Promise.all([...this.workers.keys()].map(account => this.stopAccount(account)));
  }
}

export class PlaywrightTab implements BrowserTab {
  readonly target = randomUUID();
  constructor(private readonly page: Page, private readonly context: BrowserContext,
    private readonly fileKey: string, readonly generation: string, private readonly valid: () => boolean,
    private readonly cleanup?: () => Promise<void>) {}
  async check(write = false): Promise<void> {
    if (!this.valid() || this.page.isClosed()) fault('target_invalid', 'Target generation is no longer valid.', 409);
    const state = await editorReadiness(this.page, this.fileKey);
    if (state !== 'ready') fault(state, 'The leased Figma editor is no longer ready.', 409);
    if (write) {
      try { await requireEditing(this.page); }
      catch (error) {
        if (!(error instanceof Fault) || error.code !== 'editing_unsupported'
            || !await nativeEditorReady(this.page)) throw error;
      }
    }
    if (!this.valid() || this.page.isClosed()) fault('target_invalid', 'Target generation was lost during its readiness check.', 409);
  }
  close(): Promise<void> { return this.cleanup ? this.cleanup() : this.page.isClosed() ? Promise.resolve() : this.page.close(); }
  inspect(): Promise<Record<string, unknown>> { return inspection(this.page); }
  readValue(locator: LocatorSpec): Promise<string> { return readValue(this.page, locator); }
  async reload(): Promise<void> {
    const response = await this.page.reload({ waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) fault('site_blocked', 'Reload returned an HTTP error; reopen the file with a new lease.', 409);
    const until = Date.now() + 15_000;
    while (await editorReadiness(this.page, this.fileKey) === 'ui_unsupported' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await this.check();
  }
  screenshot(scope?: LocatorSpec): Promise<Buffer> {
    return scope ? locate(this.page, scope).screenshot({ type: 'png', timeout: 5000 })
      : this.page.screenshot({ type: 'png', fullPage: false, timeout: 5000 });
  }
  private async withModifiers(modifiers: Modifier[] | undefined, operation: () => Promise<void>): Promise<void> {
    const pressed: string[] = [];
    try {
      for (const key of modifierKeys(modifiers ?? [])) { pressed.push(key); await this.page.keyboard.down(key); }
      await operation();
    } finally {
      let failed = false;
      for (const key of pressed.reverse()) { try { await this.page.keyboard.up(key); } catch { failed = true; } }
      if (failed && !this.page.isClosed()) fault('modifier_cleanup_failed', 'Modifier release could not be confirmed; close the target.', 409);
    }
  }
  click(spec: LocatorSpec, modifiers?: Modifier[]): Promise<void> {
    return this.withModifiers(modifiers, () => locate(this.page, spec).click());
  }
  pointerClick(point: { x: number; y: number }, clicks: 1 | 2, button: 'left' | 'right', modifiers?: Modifier[]): Promise<void> {
    return this.withModifiers(modifiers, () => this.page.mouse.click(point.x, point.y, { clickCount: clicks, button }));
  }
  typeText(text: string): Promise<void> { return this.page.keyboard.insertText(text); }
  async wheel(point: { x: number; y: number }, deltaX: number, deltaY: number): Promise<void> {
    await this.page.mouse.move(point.x, point.y); await this.page.mouse.wheel(deltaX, deltaY);
  }
  fill(spec: LocatorSpec, text: string): Promise<void> { return locate(this.page, spec).fill(text); }
  keypress(keys: string): Promise<void> { return this.page.keyboard.press(keys); }
  drag(from: { x: number; y: number }, to: { x: number; y: number }, modifiers?: Modifier[]): Promise<void> {
    return this.withModifiers(modifiers, async () => {
      await this.page.mouse.move(from.x, from.y);
      try {
        await this.page.mouse.down();
        await this.page.mouse.move(to.x, to.y, { steps: 10 });
      } finally { await this.page.mouse.up(); }
    });
  }
  async uploadImage(image: ImagePayload, trigger: LocatorSpec, signal?: AbortSignal): Promise<void> {
    let choose!: (chooser: FileChooser) => void, reject!: (error: unknown) => void;
    const ready = new Promise<FileChooser>((resolve, fail) => { choose = resolve; reject = fail; });
    void ready.catch(() => undefined);
    const aborted = () => reject(new Fault('cancelled', 'Image upload was cancelled.', 409));
    const closed = () => reject(new Fault('target_invalid', 'Image upload target closed.', 409));
    const timer = setTimeout(() => reject(new Fault('upload_timeout', 'The trigger did not open a file chooser.', 409)), 5000);
    this.page.once('filechooser', choose);
    this.page.once('close', closed);
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      signal?.throwIfAborted();
      await locate(this.page, trigger).click({ timeout: 5000 });
      const chooser = await ready;
      signal?.throwIfAborted();
      await this.check(true);
      await chooser.setFiles({ name: image.name, mimeType: image.mimeType, buffer: image.buffer }, { timeout: 5000 });
    } finally {
      clearTimeout(timer);
      this.page.removeListener('filechooser', choose);
      this.page.removeListener('close', closed);
      signal?.removeEventListener('abort', aborted);
    }
  }
  paste(html: string, target?: LocatorSpec): Promise<void> { return pasteHtml(this.page, html, target); }
  verify(expectation?: Expectation): Promise<Verification> { return verify(this.page, expectation); }
  async metrics(): Promise<Record<string, number>> {
    const cdp = await this.context.newCDPSession(this.page);
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics');
      return { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight };
    } finally { await cdp.detach(); }
  }
}
