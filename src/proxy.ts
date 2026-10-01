import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InitializeResultSchema, isInitializeRequest, isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { Transform } from 'node:stream';
import { State } from './state.js';
import { fault } from './errors.js';
import { isUploadRequest, LIMITS, suppliedImage } from './security.js';
import { toolSchemas } from './tools.js';

export const DAEMON_URL = 'http://127.0.0.1:4317';
let largeFrames = 0;

// Forward the protocol unchanged, including IDs, notifications and cancellation.
// The SDK owns framing, HTTP sessions and SSE; there is no second MCP server.
export async function stdioProxy(state: State, options: {
  stdin?: Readable; stdout?: Writable; stderr?: Writable; signal?: AbortSignal;
} = {}): Promise<void> {
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const diagnostics = options.stderr ?? process.stderr;
  const token = await state.secret();
  let lineBytes = 0;
  let lineRelease: (() => void) | undefined;
  const reservations = new Set<() => void>();
  const frames: { bytes: number; release?: () => void }[] = [];
  const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    // Bound each segment before it reaches the SDK's ReadBuffer. Splitting at
    // LF also prevents a single chunk from buffering many messages at once.
    let offset = 0;
    while (offset < chunk.length && !closing) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      lineBytes += end - offset;
      if (lineBytes > LIMITS.uploadBodyBytes) { callback(new Error('MCP input line exceeds its limit.')); return; }
      if (lineBytes > LIMITS.bodyBytes && !lineRelease) {
        if (largeFrames >= LIMITS.uploads) { callback(new Error('MCP upload capacity is unavailable.')); return; }
        largeFrames++;
        const release = () => { if (reservations.delete(release)) largeFrames--; };
        reservations.add(release);
        lineRelease = release;
      }
      if (newline >= 0) {
        frames.push({ bytes: lineBytes, release: lineRelease });
        lineBytes = 0;
        lineRelease = undefined;
      }
      this.push(chunk.subarray(offset, newline < 0 ? end : end + 1));
      offset = newline < 0 ? end : end + 1;
    }
    callback();
  } });
  const upstream = new StreamableHTTPClientTransport(new URL(`${DAEMON_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => fetch(url, {
      ...init, redirect: 'error',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []),
        ...(init?.method === 'GET' ? [] : [AbortSignal.timeout(init?.method === 'DELETE' ? 3000 : 45_000)])]),
    }),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const downstream = new StdioServerTransport(guard, output, { maxBufferSize: LIMITS.uploadBodyBytes + 1 });
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  let handshake = Promise.resolve();
  let initializeId: string | number | undefined;
  let active = 0;
  const pending = new Set<Promise<void>>();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      input.off('end', onEnd);
      input.unpipe(guard);
      output.off('error', onOutputError);
      options.signal?.removeEventListener('abort', onEnd);
      await downstream.close();
      guard.destroy();
      // An initialize already on the wire may still create a session. Let it
      // settle before DELETE, rather than abandoning the new session on EOF.
      await handshake.catch(() => undefined);
      try { await upstream.terminateSession(); }
      catch { diagnostics.write('MCP session cleanup could not be confirmed. Run figma-server status; restart the daemon if a file remains busy.\n'); }
      finally {
        await upstream.close();
        await Promise.allSettled(pending);
        for (const release of reservations) release();
        frames.length = 0;
        finish();
      }
    })();
    return closing;
  };
  const fail = (error: unknown): void => {
    if (closing) return;
    failure = error instanceof StreamableHTTPError && error.code === 401
      ? new Error('The daemon rejected local authentication. Stop it and run figma-server run using this OS account.')
      : new Error('MCP connection failed. Run figma-server doctor, then keep figma-server run open in another terminal.');
    void close();
  };
  const onEnd = (): void => { void close(); };
  const onOutputError = (): void => { fail(undefined); };
  upstream.onerror = fail;
  downstream.onerror = fail;
  guard.on('error', fail);
  upstream.onmessage = message => {
    if (isJSONRPCResultResponse(message) && message.id === initializeId) {
      const initialized = InitializeResultSchema.safeParse(message.result);
      if (initialized.success) upstream.setProtocolVersion(initialized.data.protocolVersion);
    }
    if (!closing) void downstream.send(message).catch(fail);
  };
  downstream.onmessage = message => {
    if (closing) return;
    const frame = frames.shift();
    if (!frame) { fail(undefined); return; }
    if (frame.bytes > LIMITS.bodyBytes) {
      try {
        if (!isUploadRequest(message)) throw new Error('Only uploads permit large frames.');
        const image = toolSchemas['figma.upload_image'].parse('params' in message ? message.params?.arguments : undefined);
        const encoded = image.data_base64;
        const bytes = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        // Check decoded size and raw overhead before allocating an image Buffer.
        if (bytes > LIMITS.imageBytes || frame.bytes - encoded.length > LIMITS.uploadMetadataBytes) throw new Error('Upload exceeds its limits.');
        suppliedImage(image.filename, encoded);
      } catch { frame.release?.(); fail(undefined); return; }
    }
    if (active >= LIMITS.queue) { fail(undefined); return; }
    active++;
    let sent: Promise<void>;
    if (isInitializeRequest(message) && 'id' in message) {
      initializeId = message.id;
      handshake = upstream.send(message);
      sent = handshake;
    } else if ('method' in message && message.method === 'notifications/initialized') {
      handshake = handshake.then(() => upstream.send(message));
      sent = handshake;
    } else {
      // Only initialization is ordered: a long tool call must not prevent its
      // cancellation notification or other independent requests reaching HTTP.
      sent = handshake.then(() => upstream.send(message));
    }
    const settled = sent.catch(fail).finally(() => { active--; frame.release?.(); pending.delete(settled); });
    pending.add(settled);
  };
  input.once('end', onEnd);
  output.once('error', onOutputError);
  options.signal?.addEventListener('abort', onEnd, { once: true });
  await upstream.start();
  if (options.signal?.aborted || input.readableEnded) await close();
  else { await downstream.start(); input.pipe(guard); }
  await done;
  if (failure) fault('mcp_connection_failed', failure.message, 503);
}
