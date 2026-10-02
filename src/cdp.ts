import type { CDPSession } from 'playwright';
import { fault, Fault } from './errors.js';
import { LIMITS } from './security.js';

export type CdpScope = 'tab' | 'browser';
export type CdpReply = { status: 'completed'; result: unknown } | {
  status: 'failed'; error: { code: string; message: string }; effectsMayHaveOccurred: true;
};
export function cdpFailure(code: string, error: unknown): CdpReply {
  return { status: 'failed', error: { code, message: (error instanceof Error ? error.message : String(error)).slice(0, 8192) }, effectsMayHaveOccurred: true };
}
export function cdpJson(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) > LIMITS.cdpResultBytes) fault('cdp_output_limit', 'CDP output exceeds 1 MiB; the command may already have taken effect.', 413);
  return json;
}

export class CdpChannel {
  private readonly buffer: { sequence: number; json: string; bytes: number }[] = [];
  private readonly waiters = new Set<() => void>();
  private bytes = 0;
  private sequence = 0;
  private dropped = 0;
  private closed = false;
  private detached = false;
  private closing?: Promise<void>;
  private readonly ended: Promise<void>;
  private readonly onEvent = (event: { method: string; params?: object }): void => {
    if (this.closed) return;
    const sequence = ++this.sequence;
    try {
      const json = cdpJson({ sequence, ...event });
      const bytes = Buffer.byteLength(json);
      this.buffer.push({ sequence, json, bytes }); this.bytes += bytes;
      while (this.buffer.length > LIMITS.cdpEvents || this.bytes > LIMITS.cdpEventBytes - 4096) {
        this.bytes -= this.buffer.shift()!.bytes; this.dropped++;
      }
    } catch { this.dropped++; }
    this.wake();
  };
  constructor(private readonly session: CDPSession) {
    this.ended = new Promise(resolve => session.once('close', () => {
      this.closed = true; this.detached = true; session.off('event', this.onEvent); this.wake(); resolve();
    }));
    session.on('event', this.onEvent);
  }
  private wake(): void { for (const wake of this.waiters) wake(); }
  async send(command: string, params: Record<string, unknown>): Promise<CdpReply> {
    if (this.closed) return cdpFailure('cdp_session_closed', 'This CDP connection is closed; explicitly reopen it with a new call.');
    try {
      // Only the TypeScript signature is narrowed by Playwright's bundled protocol.
      // Runtime forwarding deliberately has no method or parameter allowlist.
      const send = this.session.send as (method: string, params: object) => Promise<unknown>;
      const result = await send.call(this.session, command, params);
      return { status: 'completed', result: JSON.parse(cdpJson(result)) as unknown };
    } catch (error) {
      return cdpFailure(error instanceof Fault ? error.code : 'cdp_protocol_error', error);
    }
  }
  async events(after: number, limit: number, waitMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (after > this.sequence) return { ...cdpFailure('invalid_cursor', 'The cursor is ahead of this CDP connection.') };
    if (waitMs && this.sequence <= after && !this.closed) await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Fault('indeterminate', 'CDP event wait cancelled.', 409)); };
      const timer = setTimeout(finish, waitMs);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(finish); signal?.removeEventListener('abort', abort); };
      this.waiters.add(finish); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.sequence > after || this.closed) finish();
    });
    const available = this.buffer.filter(event => event.sequence > after);
    const batch = available.slice(0, limit);
    const hasMore = available.length > batch.length;
    return { status: 'completed', events: batch.map(event => JSON.parse(event.json) as unknown),
      cursor: hasMore ? batch.at(-1)!.sequence : this.sequence, has_more: hasMore,
      oldest_cursor: this.buffer[0]?.sequence ?? this.sequence + 1, dropped_events: this.dropped, closed: this.closed };
  }
  close(): Promise<void> {
    if (this.detached) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closed = true; this.wake();
    this.session.off('event', this.onEvent);
    this.closing = Promise.race([this.session.detach(), this.ended]);
    return this.closing;
  }
}
