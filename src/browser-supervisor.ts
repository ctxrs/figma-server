import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { type Config, State, privateDirectory } from './state.js';
import { LIMITS, permittedNavigation, sameFile, type Expectation, type LocatorSpec } from './security.js';
import { Fault, fault } from './errors.js';
import { inspection, locate, pasteHtml, probe, readValue, requireEditor, requireEditing, verify, type Readiness, type Verification } from './figma-adapter.js';

export interface BrowserTab {
  readonly target: string;
  readonly generation: string;
  close(): Promise<void>;
  check(write?: boolean): Promise<void>;
  inspect(): Promise<Record<string, unknown>>;
  readValue(locator: LocatorSpec): Promise<string>;
  reload(): Promise<void>;
  screenshot(scope?: LocatorSpec): Promise<Buffer>;
  click(locator: LocatorSpec): Promise<void>;
  pointerClick(point: { x: number; y: number }, clicks: 1 | 2, button: 'left' | 'right'): Promise<void>;
  typeText(text: string): Promise<void>;
  wheel(point: { x: number; y: number }, deltaX: number, deltaY: number): Promise<void>;
  fill(locator: LocatorSpec, text: string): Promise<void>;
  keypress(keys: string): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
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
export class BrowserSupervisor implements BrowserBackend {
  readonly workers = new Map<string, Worker>();
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
        if (request.isNavigationRequest() && (!permittedNavigation(request.url(), extra) || (!headed && await request.frame().page().opener()))) await route.abort('blockedbyclient');
        else await route.fallback();
      });
      context.on('page', page => {
        if (!headed) page.on('popup', popup => { void popup.close().catch(() => undefined); });
        else page.on('framenavigated', frame => {
          if (!permittedNavigation(frame.url(), extra)) void page.close().catch(() => undefined);
        });
        page.on('download', download => { void download.cancel().catch(() => undefined); });
      });
      context.on('close', () => {
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
  async open(account: string, url: string, fileKey: string): Promise<BrowserTab> {
    if (this.status(account).state === 'authorizing') fault('account_busy', 'Account login is in progress.', 409);
    if (this.status(account).state === 'crashed') fault('browser_crashed', 'Restart or log in to recover the account.', 503);
    const worker = await this.ensure(account);
    const page = await worker.context.newPage();
    const tab = new PlaywrightTab(page, worker.context, fileKey, worker.generation, () => valid && this.workers.get(account) === worker);
    let valid = true;
    const invalidate = () => { valid = false; void page.close().catch(() => undefined); };
    page.on('crash', invalidate);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && !sameFile(frame.url(), fileKey)) invalidate();
    });
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400 && response.status() !== 401) {
        this.set(worker, 'site_blocked');
        fault('site_blocked', 'The site returned an HTTP error; this does not prove a missing login.', 503);
      }
      const until = Date.now() + 15_000;
      let state = await probe(page, fileKey);
      while (state === 'ui_unsupported' && valid && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 250));
        state = await probe(page, fileKey);
      }
      // A denied or unsupported file is target-specific, not account browser failure.
      if (state === 'ready' || state === 'needs_login' || state === 'crashed') this.set(worker, state);
      if (state !== 'ready' || !valid) fault(state, 'Figma editor readiness could not be confirmed.', 409);
      return tab;
    } catch (error) {
      const { bounded } = await import('./scheduler.js');
      try { await bounded(tab.close(), undefined, 5000); }
      catch { throw new BrowserOpenFailure(tab); }
      if (!valid) this.set(worker, 'needs_login');
      if (!(error instanceof Fault)) {
        this.set(worker, 'network_error');
        fault('network_error', 'Figma navigation failed before editor readiness could be assessed.', 503);
      }
      throw error;
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
          timer = setTimeout(() => reject(new Error('login_timeout')), LIMITS.loginMs);
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
    private readonly fileKey: string, readonly generation: string, private readonly valid: () => boolean) {}
  async check(write = false): Promise<void> {
    if (!this.valid() || this.page.isClosed()) fault('target_invalid', 'Target generation is no longer valid.', 409);
    await requireEditor(this.page, this.fileKey);
    if (write) await requireEditing(this.page);
  }
  close(): Promise<void> { return this.page.isClosed() ? Promise.resolve() : this.page.close(); }
  inspect(): Promise<Record<string, unknown>> { return inspection(this.page); }
  readValue(locator: LocatorSpec): Promise<string> { return readValue(this.page, locator); }
  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const until = Date.now() + 15_000;
    while (await probe(this.page, this.fileKey) === 'ui_unsupported' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await this.check();
  }
  screenshot(scope?: LocatorSpec): Promise<Buffer> {
    return scope ? locate(this.page, scope).screenshot({ type: 'png', timeout: 5000 })
      : this.page.screenshot({ type: 'png', fullPage: false, timeout: 5000 });
  }
  click(spec: LocatorSpec): Promise<void> { return locate(this.page, spec).click(); }
  pointerClick(point: { x: number; y: number }, clicks: 1 | 2, button: 'left' | 'right'): Promise<void> {
    return this.page.mouse.click(point.x, point.y, { clickCount: clicks, button });
  }
  typeText(text: string): Promise<void> { return this.page.keyboard.insertText(text); }
  async wheel(point: { x: number; y: number }, deltaX: number, deltaY: number): Promise<void> {
    await this.page.mouse.move(point.x, point.y); await this.page.mouse.wheel(deltaX, deltaY);
  }
  fill(spec: LocatorSpec, text: string): Promise<void> { return locate(this.page, spec).fill(text); }
  keypress(keys: string): Promise<void> { return this.page.keyboard.press(keys); }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    try { await this.page.mouse.move(to.x, to.y, { steps: 10 }); } finally { await this.page.mouse.up(); }
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
