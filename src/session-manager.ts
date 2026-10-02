import { randomUUID } from 'node:crypto';
import { BrowserOpenFailure, type BrowserBackend, type BrowserTab } from './browser-supervisor.js';
import { Fault, fault } from './errors.js';
import { LIMITS, fileUrl } from './security.js';
import { FileLocks, TargetQueue, bounded } from './scheduler.js';
import type { Metadata } from './state.js';
import type { CdpScope } from './cdp.js';

export type Lease = {
  id: string; session: string; account: string; fileKey: string; target: string; generation: string;
  touched: number; mode: 'read' | 'write'; tab: BrowserTab; queue: TargetQueue;
  invalid: boolean; unlock?: () => void; closing?: Promise<void>; quarantined: boolean;
  rawRevoked?: boolean; browserEnded?: boolean;
};
type Session = { id: string; touched: number; controller: AbortController };
export class SessionManager {
  readonly leases = new Map<string, Lease>();
  readonly sessions = new Map<string, Session>();
  readonly files = new FileLocks();
  private pending = 0;
  private waiters = 0;
  private stopping = false;
  private readonly authorizing = new Set<string>();
  constructor(readonly browser: BrowserBackend, readonly metadata: Metadata, private readonly now = Date.now) {
    browser.onCrash = account => { void this.invalidateAccount(account, true).catch(() => undefined); };
  }
  createSession(): string {
    if (this.stopping || this.sessions.size >= LIMITS.sessions) fault('session_limit', 'Session capacity is unavailable.', 429);
    const id = randomUUID();
    this.sessions.set(id, { id, touched: this.now(), controller: new AbortController() });
    return id;
  }
  session(id: string): Session {
    const value = this.sessions.get(id);
    if (!value || value.controller.signal.aborted || this.stopping) fault('invalid_session', 'Session is invalid or expired.', 404);
    value.touched = this.now();
    return value;
  }
  async open(session: string, account: string, input: string, mode: 'read' | 'write', signal?: AbortSignal): Promise<Record<string, unknown>> {
    const owner = this.session(session);
    const combined = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    combined.throwIfAborted();
    this.browser.status(account);
    if (this.authorizing.has(account)) fault('account_busy', 'Account login is in progress.', 409);
    if (this.waiters >= LIMITS.queue) fault('queue_full', 'Lease acquisition capacity is unavailable.', 429);
    const file = fileUrl(input);
    this.waiters++;
    let reserved = false;
    let unlock: (() => void) | undefined;
    let tab: BrowserTab | undefined;
    try {
      if (mode === 'write') unlock = await this.files.acquire(file.fileKey, combined);
      this.session(session);
      if (this.authorizing.has(account)) fault('account_busy', 'Account login is in progress.', 409);
      if (this.leases.size + this.pending >= LIMITS.tabs) fault('tab_limit', 'Tab capacity is unavailable.', 429);
      this.pending++;
      reserved = true;
      // A pending open must settle before its file lock can be released. If its
      // signal is cancelled, finish opening then close; do not abandon the browser promise.
      tab = await this.browser.open(account, file.url, file.fileKey);
      combined.throwIfAborted();
      this.session(session);
      if (this.authorizing.has(account)) fault('account_busy', 'Account login is in progress.', 409);
      const value: Lease = { id: randomUUID(), session, account, fileKey: file.fileKey, target: tab.target,
        generation: tab.generation, touched: this.now(), mode, tab, queue: new TargetQueue(), invalid: false,
        quarantined: false, ...(unlock ? { unlock } : {}) };
      this.leases.set(value.id, value);
      this.metadata.lease(value);
      return this.info(value);
    } catch (error) {
      if (error instanceof BrowserOpenFailure) tab = error.tab;
      if (tab) {
        const orphan: Lease = { id: randomUUID(), session, account, fileKey: file.fileKey, target: tab.target,
          generation: tab.generation, touched: this.now(), mode, tab, queue: new TargetQueue(), invalid: true,
          quarantined: false, ...(unlock ? { unlock } : {}) };
        this.leases.set(orphan.id, orphan);
        this.metadata.lease(orphan);
        // closeLease tracks both failure and later confirmed closure; don't lose
        // an orphan's lock or underreport quarantine if cancellation raced open.
        await this.closeLease(orphan);
        unlock = undefined;
      }
      unlock?.();
      throw error;
    } finally { this.waiters--; if (reserved) this.pending--; }
  }
  info(lease: Lease): Record<string, unknown> {
    return { lease: lease.id, account: lease.account, fileKey: lease.fileKey, targetId: lease.target,
      generation: lease.generation, mode: lease.mode, expiresAt: new Date(lease.touched + LIMITS.leaseMs).toISOString() };
  }
  get(session: string, id: string, write = false): Lease {
    this.session(session);
    const value = this.leases.get(id);
    if (!value || value.invalid || value.session !== session || value.touched + LIMITS.leaseMs <= this.now()) {
      fault('invalid_lease', 'Lease does not belong to this session or has expired.', 404);
    }
    const status = this.browser.status(value.account);
    if (status.generation !== value.generation || ['crashed', 'stopped', 'starting', 'authorizing'].includes(status.state)) fault('invalid_generation', 'Account or target generation is no longer ready.', 409);
    if (write && value.mode !== 'write') fault('read_only', 'A write lease is required.', 403);
    value.touched = this.now();
    this.metadata.lease(value);
    return value;
  }
  async execute<T>(session: string, id: string, write: boolean, task: (lease: Lease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = this.get(session, id, write);
    const owner = this.session(session);
    const combined = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    try { return await lease.queue.run(async () => {
      this.get(session, id, write);
      return await bounded((async () => {
          await lease.tab.check(write);
          const result = await task(lease);
          await lease.tab.check();
          this.get(session, id, write);
          return result;
      })(), combined);
    }, combined); } catch (error) {
      // Closure failure changes any result to indeterminate. The retained file
      // lock quarantines ongoing browser work even when the first error was a selector failure.
      await this.closeLease(lease);
      if (combined.aborted) fault('indeterminate', 'Operation cancelled; the target has been closed.', 409);
      throw error;
    }
  }
  async release(session: string, id: string): Promise<Record<string, unknown>> {
    const value = this.get(session, id);
    value.rawRevoked = true;
    await this.closeLease(value);
    return { released: true };
  }
  async executeRaw<T>(session: string, id: string, scope: CdpScope, task: (lease: Lease, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal, timeout: number = LIMITS.operationMs): Promise<T> {
    const lease = this.get(session, id, true);
    const owner = this.session(session);
    const combined = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    const run = async () => {
      this.get(session, id, true);
      if (!lease.tab.checkRaw) fault('cdp_unsupported', 'This browser adapter does not expose raw CDP.', 409);
      return bounded((async () => {
        await lease.tab.checkRaw!(scope);
        this.get(session, id, true);
        const result = await task(lease, combined);
        // A successful raw command may deliberately close its target/browser.
        // Check the logical caller, not an editor postcondition or live target.
        combined.throwIfAborted(); this.session(session);
        if (lease.rawRevoked || lease.invalid && !lease.browserEnded || lease.touched + LIMITS.leaseMs <= this.now()) {
          fault('indeterminate', 'The raw handle was released, invalidated or expired; its late result was discarded. Effects may have occurred.', 409);
        }
        return result;
      })(), combined, timeout);
    };
    // Debugger/Fetch commands can pause other RPCs on this exact connection.
    // They must remain concurrent so resume/continue/event calls can complete.
    try { return await run(); }
    catch (error) {
      lease.rawRevoked = true;
      await this.closeLease(lease);
      if (combined.aborted) fault('indeterminate', 'Raw operation cancelled; owned target cleanup completed or quarantined.', 409);
      throw error;
    }
  }
  async closeLease(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing;
    lease.invalid = true;
    const finish = () => {
      if (!this.leases.delete(lease.id)) return;
      this.metadata.removeLease(lease.id);
      lease.unlock?.();
    };
    const closure = lease.tab.close();
    // If a bounded wait expires but Page.close later confirms termination,
    // recover the quarantine only at that confirmation, never merely on a timer.
    void closure.then(finish).catch(() => undefined);
    lease.closing = (async () => {
      try {
        await bounded(closure, undefined, 5000);
        finish();
      } catch {
        lease.quarantined = true;
        // Retain the file lock. Only confirmed browser teardown / daemon restart
        // can recover this file, never a timeout that merely abandons a promise.
        fault('indeterminate', 'Target closure could not be confirmed; its file remains quarantined.', 409);
      }
    })();
    return lease.closing;
  }
  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    session?.controller.abort();
    this.sessions.delete(id);
    await Promise.allSettled([...this.leases.values()].filter(l => l.session === id).map(l => this.closeLease(l)));
  }
  async invalidateAccount(account: string, retryClosure = false): Promise<void> {
    if (retryClosure) {
      for (const lease of this.leases.values()) if (lease.account === account) {
        lease.browserEnded = true;
        if (lease.quarantined) lease.closing = undefined;
      }
    }
    await Promise.allSettled([...this.leases.values()].filter(l => l.account === account).map(l => this.closeLease(l)));
  }
  async login(account: string, confirm: () => Promise<void>): Promise<unknown> {
    this.browser.status(account);
    if (this.authorizing.has(account)) fault('account_busy', 'Login is already active.', 409);
    this.authorizing.add(account);
    try {
      await this.invalidateAccount(account);
      if ([...this.leases.values()].some(l => l.account === account)) fault('indeterminate', 'Account has quarantined targets; restart the daemon before login.', 409);
      return await this.browser.login(account, confirm);
    } finally { this.authorizing.delete(account); }
  }
  async sweep(): Promise<void> {
    for (const lease of [...this.leases.values()]) {
      if (lease.touched + LIMITS.leaseMs <= this.now() && !lease.invalid) {
        lease.rawRevoked = true; await this.closeLease(lease).catch(() => undefined);
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.touched + LIMITS.leaseMs <= this.now()) await this.closeSession(session.id);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)));
    await this.browser.stop();
  }
}
