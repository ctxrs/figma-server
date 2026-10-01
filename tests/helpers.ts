import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserBackend, BrowserTab, AccountStatus } from '../src/browser-supervisor.js';
import { Core } from '../src/core.js';
import { fault } from '../src/errors.js';
import type { Expectation, LocatorSpec } from '../src/security.js';
import { State, Metadata } from '../src/state.js';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPqkAAAAASUVORK5CYII=', 'base64');
export class FakeTab implements BrowserTab {
  readonly target = randomUUID();
  closed = false;
  operations: string[] = [];
  block: Promise<void> | undefined;
  blockClose: Promise<void> | undefined;
  failClose = false;
  constructor(readonly generation: string) {}
  async close(): Promise<void> { if (this.closed) return; if (this.failClose) throw new Error('close failed'); await this.blockClose; this.closed = true; }
  async check(): Promise<void> { if (this.closed) fault('target_invalid', 'Target is closed.', 409); }
  async inspect(): Promise<Record<string, unknown>> { return { layers: ['Frame 1'], accessibility: { treeitems: 1 } }; }
  async readValue(_locator: LocatorSpec): Promise<string> { return 'Frame 1'; }
  async reload(): Promise<void> { this.operations.push('reload'); }
  async screenshot(_scope?: LocatorSpec): Promise<Buffer> { return PNG; }
  async click(_locator: LocatorSpec): Promise<void> { await this.block; await this.check(); this.operations.push('click'); }
  async pointerClick(_point: { x: number; y: number }, _clicks: 1 | 2, _button: 'left' | 'right'): Promise<void> { this.operations.push('pointer_click'); }
  async typeText(_text: string): Promise<void> { this.operations.push('type_text'); }
  async wheel(_point: { x: number; y: number }, _deltaX: number, _deltaY: number): Promise<void> { this.operations.push('wheel'); }
  async fill(_locator: LocatorSpec, _text: string): Promise<void> { this.operations.push('fill'); }
  async keypress(_keys: string): Promise<void> { this.operations.push('keypress'); }
  async drag(_from: { x: number; y: number }, _to: { x: number; y: number }): Promise<void> { this.operations.push('drag'); }
  async paste(_html: string, _target?: LocatorSpec): Promise<void> { this.operations.push('paste'); }
  async verify(expected?: Expectation): Promise<{ status: 'verified' | 'unverified'; saveState: 'saved'; checks: string[] }> {
    return { status: expected ? 'verified' : 'unverified', saveState: 'saved', checks: expected ? ['visibility', 'saved'] : [] };
  }
  async metrics(): Promise<Record<string, number>> { return { width: 1920, height: 1200 }; }
}
export class FakeBrowser implements BrowserBackend {
  readonly generation = randomUUID();
  readonly tabs: FakeTab[] = [];
  readonly states = new Map<string, AccountStatus>();
  onCrash?: (account: string) => void;
  constructor(accounts = ['default', 'other']) { for (const account of accounts) this.states.set(account, { account, state: 'ready', generation: this.generation }); }
  status(account: string): AccountStatus {
    const status = this.states.get(account);
    if (!status) fault('unknown_account', 'Account is not configured.', 404);
    return status;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> { for (const tab of this.tabs) { tab.failClose = false; await tab.close(); } }
  async open(account: string, _url: string, _key: string): Promise<BrowserTab> {
    this.status(account);
    const tab = new FakeTab(this.generation);
    this.tabs.push(tab); return tab;
  }
  async login(account: string, confirm: () => Promise<void>): Promise<AccountStatus> { await confirm(); return this.status(account); }
  crash(account = 'default'): void {
    this.states.set(account, { account, state: 'crashed' });
    for (const tab of this.tabs) tab.closed = true;
    this.onCrash?.(account);
  }
}
export async function setup(): Promise<{ core: Core; state: State; browser: FakeBrowser; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-server-test-')));
  const state = new State(root);
  await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }, { name: 'other', loginOrigins: [] }] });
  const browser = new FakeBrowser();
  const core = new Core(browser, state, await Metadata.open(state));
  return { core, state, browser, cleanup: async () => { await core.stop(); await rm(root, { recursive: true, force: true }); } };
}
export async function open(core: Core, session: string, file = 'abcdef123', mode: 'read' | 'write' = 'write', account = 'default'): Promise<{ lease: string; fileKey: string; targetId: string }> {
  return await core.call(session, 'figma.open', { file_url: `https://www.figma.com/design/${file}`, mode, account }) as { lease: string; fileKey: string; targetId: string };
}
export const locator: LocatorSpec = { by: 'role', role: 'button', name: 'Draw' };
export async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 10)); }
