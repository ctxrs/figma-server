import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserBackend } from './browser-supervisor.js';
import { publicError, Fault, fault } from './errors.js';
import { Artifacts, type Receipt } from './receipts.js';
import { LIMITS, safeHtml, suppliedImage, type Expectation } from './security.js';
import { SessionManager, type Lease } from './session-manager.js';
import { Metadata, State } from './state.js';
import { parseTool, type ToolInput, type ToolName } from './tools.js';
import { cdpFailure, cdpJson } from './cdp.js';

const writes = new Set<ToolName>(['figma.click', 'figma.pointer_click', 'figma.type_text', 'figma.wheel', 'figma.fill', 'figma.keypress', 'figma.drag', 'figma.paste_html', 'figma.upload_image']);
export class Core {
  readonly sessions: SessionManager;
  readonly artifacts: Artifacts;
  private readonly active = new Set<Promise<unknown>>();
  private stopping = false;
  private uploads = 0;
  constructor(readonly browser: BrowserBackend, readonly state: State, readonly metadata: Metadata) {
    this.sessions = new SessionManager(browser, metadata);
    this.artifacts = new Artifacts(state);
  }
  status(): unknown {
    return { leases: this.sessions.leases.size, quarantined: [...this.sessions.leases.values()].filter(l => l.quarantined).length,
      sessions: this.sessions.sessions.size };
  }
  async call(session: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopping) fault('shutting_down', 'Daemon is shutting down.', 503);
    const operation = this.dispatch(session, name, args, signal);
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }
  private async dispatch(session: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const parsed = parseTool(name, args);
    this.sessions.session(session);
    if (parsed.name === 'figma.paste_html') safeHtml((parsed.input as ToolInput<'figma.paste_html'>).html);
    // Strict parseTool ensures each switch arm's assertion matches its schema.
    switch (parsed.name) {
      case 'figma.account_status': return this.browser.status((parsed.input as ToolInput<'figma.account_status'>).account);
      case 'figma.open': {
        const value = parsed.input as ToolInput<'figma.open'>;
        return this.sessions.open(session, value.account, value.file_url, value.mode, signal);
      }
      case 'figma.release': return this.sessions.release(session, (parsed.input as ToolInput<'figma.release'>).lease);
      case 'figma.heartbeat': return this.sessions.info(this.sessions.get(session, (parsed.input as ToolInput<'figma.heartbeat'>).lease));
      case 'figma.artifact_read': {
        const input = parsed.input as ToolInput<'figma.artifact_read'>;
        await this.artifacts.read(session, input.job_id, input.file);
        return { artifact: `artifacts/${input.job_id}/${input.file}`, kind: 'rendered_png' };
      }
      case 'figma.evaluate': {
        const input = parsed.input as ToolInput<'figma.evaluate'>;
        return this.sessions.executeRaw(session, input.lease, 'tab', async lease => {
          if (!lease.tab.cdp) fault('cdp_unsupported', 'This browser adapter does not expose raw CDP.', 409);
          const reply = await lease.tab.cdp('tab', 'Runtime.evaluate', { expression: input.expression,
            awaitPromise: input.await_promise, returnByValue: true, timeout: input.timeout_ms, userGesture: false });
          if (reply.status === 'failed') return reply;
          const result = reply.result as { exceptionDetails?: unknown };
          return result.exceptionDetails ? { ...reply, status: 'failed', error: { code: 'javascript_exception', message: 'JavaScript threw; inspect exceptionDetails.' } } : reply;
        }, signal, input.timeout_ms);
      }
      case 'figma.cdp': {
        const input = parsed.input as ToolInput<'figma.cdp'>;
        return this.sessions.executeRaw(session, input.lease, input.scope, async lease => {
          if (!lease.tab.cdp) fault('cdp_unsupported', 'This browser adapter does not expose raw CDP.', 409);
          return lease.tab.cdp(input.scope, input.command, input.params);
        }, signal);
      }
      case 'figma.cdp_events': {
        const input = parsed.input as ToolInput<'figma.cdp_events'>;
        return this.sessions.executeRaw(session, input.lease, input.scope, async (lease, combined) => {
          if (!lease.tab.cdpEvents) fault('cdp_unsupported', 'This browser adapter does not expose raw CDP events.', 409);
          const result = await lease.tab.cdpEvents(input.scope, input.after, input.limit, input.wait_ms, combined);
          try { cdpJson(result); return result; } catch (error) { return cdpFailure('cdp_output_limit', error); }
        }, signal);
      }
      case 'figma.cdp_close': {
        const input = parsed.input as ToolInput<'figma.cdp_close'>;
        return this.sessions.executeRaw(session, input.lease, input.scope, async lease => {
          if (!lease.tab.closeCdp) fault('cdp_unsupported', 'This browser adapter does not expose raw CDP.', 409);
          await lease.tab.closeCdp(input.scope); return { status: 'completed', detached: true };
        }, signal);
      }
      case 'figma.upload_image': {
        const input = parsed.input as ToolInput<'figma.upload_image'>;
        this.sessions.get(session, input.lease, true);
        if (this.uploads >= LIMITS.uploads) fault('upload_limit', 'Image upload capacity is unavailable.', 429);
        this.uploads++;
        let operation: Promise<void> | undefined;
        const release = () => { this.uploads--; };
        try {
          const image = suppliedImage(input.filename, input.data_base64);
          return await this.receipt(session, parsed.name, input.lease, input.expectation, lease => {
            if (!lease.tab.uploadImage) fault('upload_unsupported', 'This browser adapter does not support image upload.', 409);
            operation = lease.tab.uploadImage(image, input.trigger, signal);
            return operation;
          }, signal);
        } finally {
          // Cancellation may return before browser work settles. Keep its bytes
          // within the upload cap even while a failed close quarantines the page.
          if (operation) void operation.then(release, release); else release();
        }
      }
    }
    const value = parsed.input as { lease: string; expectation?: Expectation };
    if (writes.has(parsed.name) || parsed.name === 'figma.verify') {
      return this.receipt(session, parsed.name, value.lease, value.expectation, async lease => {
        switch (parsed.name) {
          case 'figma.click': {
            const input = parsed.input as ToolInput<'figma.click'>;
            await lease.tab.click(input.locator, input.modifiers); break;
          }
          case 'figma.pointer_click': {
            const input = parsed.input as ToolInput<'figma.pointer_click'>;
            await lease.tab.pointerClick(input.point, input.clicks, input.button, input.modifiers); break;
          }
          case 'figma.type_text': await lease.tab.typeText((parsed.input as ToolInput<'figma.type_text'>).text); break;
          case 'figma.wheel': {
            const input = parsed.input as ToolInput<'figma.wheel'>;
            await lease.tab.wheel(input.point, input.delta_x, input.delta_y); break;
          }
          case 'figma.fill': {
            const input = parsed.input as ToolInput<'figma.fill'>;
            await lease.tab.fill(input.locator, input.text); break;
          }
          case 'figma.keypress': await lease.tab.keypress((parsed.input as ToolInput<'figma.keypress'>).keys); break;
          case 'figma.drag': {
            const input = parsed.input as ToolInput<'figma.drag'>;
            await lease.tab.drag(input.from, input.to, input.modifiers); break;
          }
          case 'figma.paste_html': {
            const input = parsed.input as ToolInput<'figma.paste_html'>;
            safeHtml(input.html);
            await lease.tab.paste(input.html, input.target); break;
          }
        }
      }, signal);
    }
    return this.sessions.execute(session, value.lease, false, async lease => {
      switch (parsed.name) {
        case 'figma.inspect': return lease.tab.inspect();
        case 'figma.read_value': return { value: await lease.tab.readValue((parsed.input as ToolInput<'figma.read_value'>).locator) };
        case 'figma.reload': await lease.tab.reload(); return { readiness: 'ready', leaseRetained: true };
        case 'figma.screenshot':
        case 'figma.export': {
          const input = parsed.input as ToolInput<'figma.screenshot'> & ToolInput<'figma.export'>;
          const job = await this.artifacts.begin(session);
          const image = await this.artifacts.image(job, parsed.name === 'figma.export' ? 'export' : 'screenshot', await lease.tab.screenshot(input.scope ?? input.node));
          return { artifact: image, kind: 'rendered_png', nativeNodeExport: false };
        }
        case 'figma.wait_for': {
          const input = parsed.input as ToolInput<'figma.wait_for'>;
          const until = Date.now() + input.timeout;
          let verification = await lease.tab.verify(input.predicate);
          while (verification.status !== 'verified' && Date.now() < until) {
            await delay(200, undefined, signal ? { signal } : {});
            await lease.tab.check();
            verification = await lease.tab.verify(input.predicate);
          }
          return verification;
        }
        default: return fault('unknown_tool', 'Unknown tool.', 404);
      }
    }, signal);
  }
  private async receipt(session: string, name: ToolName, leaseId: string, expectation: Expectation | undefined,
    action: (lease: Lease) => Promise<void>, signal?: AbortSignal): Promise<Receipt> {
    const lease = this.sessions.get(session, leaseId, writes.has(name));
    const jobId = await this.artifacts.begin(session);
    const receipt: Receipt = { jobId, fileKey: lease.fileKey, target: lease.target, action: name,
      startedAt: new Date().toISOString(), completedAt: '', status: 'unverified' };
    try {
      await this.sessions.execute(session, leaseId, writes.has(name), async current => {
        receipt.startedAt = new Date().toISOString();
        const beforeVerification = expectation ? await current.tab.verify(expectation) : undefined;
        receipt.beforeScreenshot = await this.artifacts.image(jobId, 'before', await current.tab.screenshot());
        this.sessions.get(session, leaseId, writes.has(name));
        await current.tab.check();
        this.sessions.get(session, leaseId, writes.has(name));
        await action(current);
        await current.tab.check();
        this.sessions.get(session, leaseId, writes.has(name));
        receipt.afterScreenshot = await this.artifacts.image(jobId, 'after', await current.tab.screenshot());
        receipt.verification = await current.tab.verify(expectation);
        receipt.status = receipt.verification.status;
        if (writes.has(name) && (!expectation?.locator || !expectation.saved
          || beforeVerification?.status === 'verified' || beforeVerification?.saveState === 'saved'
          || receipt.verification.saveState !== 'saved')) {
          receipt.status = 'unverified';
          receipt.verification.status = 'unverified';
        }
      }, signal);
    } catch (error) {
      receipt.status = error instanceof Fault && error.code === 'indeterminate' ? 'indeterminate' : 'failed';
      receipt.error = publicError(error);
      // Never report a postcondition captured by a task after its lease died.
      delete receipt.verification;
    }
    receipt.completedAt = new Date().toISOString();
    this.metadata.job(jobId, receipt.fileKey, receipt.action, receipt.status);
    return this.artifacts.receipt(receipt);
  }
  async sweep(): Promise<void> {
    await this.sessions.sweep();
    this.metadata.prune();
    const { pruneArtifacts } = await import('./state.js');
    await pruneArtifacts(this.state);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.sessions.stop();
    await Promise.allSettled([...this.active]);
    await this.artifacts.stop();
    this.metadata.close();
  }
}
