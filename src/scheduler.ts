import { Fault, fault } from './errors.js';
import { LIMITS } from './security.js';

type Waiter = { enter: (unlock: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void; timer: ReturnType<typeof setTimeout> };
type Lock = { held: boolean; queue: Waiter[] };

export class FileLocks {
  private readonly locks = new Map<string, Lock>();
  async acquire(key: string, signal?: AbortSignal, timeout: number = LIMITS.operationMs): Promise<() => void> {
    signal?.throwIfAborted();
    let lock = this.locks.get(key);
    if (!lock) { lock = { held: false, queue: [] }; this.locks.set(key, lock); }
    if (!lock.held) { lock.held = true; return this.unlocker(key, lock); }
    if (lock.queue.length >= LIMITS.queue) fault('queue_full', 'File lease queue is full.', 429);
    const current = lock;
    return new Promise((enter, reject) => {
      const remove = (error: unknown) => {
        const index = current.queue.indexOf(waiter);
        if (index >= 0) current.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.abort);
        reject(error);
      };
      const waiter: Waiter = { enter, reject, abort: () => remove(new Fault('cancelled', 'Lease acquisition cancelled.', 409)),
        timer: setTimeout(() => remove(new Fault('file_busy', 'Timed out waiting for the file write lease.', 409)), timeout),
        ...(signal ? { signal } : {}) };
      current.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  private unlocker(key: string, lock: Lock): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = lock.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.signal?.removeEventListener('abort', next.abort);
        next.enter(this.unlocker(key, lock));
      } else { lock.held = false; this.locks.delete(key); }
    };
  }
}

export class TargetQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  async drain(): Promise<void> { await this.tail; }
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.pending >= LIMITS.queue) fault('queue_full', 'Target command queue is full.', 429);
    this.pending++;
    const next = this.tail.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      return task();
    });
    const settled = next.finally(() => { this.pending--; });
    this.tail = settled.catch(() => undefined);
    return settled;
  }
}

// A timeout cannot cancel a browser event already sent. The caller must close the
// target before releasing its write lock; destructive actions are never retried.
export async function bounded<T>(operation: Promise<T>, signal?: AbortSignal, timeout: number = LIMITS.operationMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new Fault('indeterminate', 'Operation cancelled; the target must be closed before another writer can proceed.', 409));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Fault('indeterminate', 'Operation timed out; the target must be closed before another writer can proceed.', 409)), timeout);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
