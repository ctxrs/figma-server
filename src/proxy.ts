import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InitializeResultSchema, isInitializeRequest, isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { Transform } from 'node:stream';
import { State } from './state.js';
import { fault } from './errors.js';
import { LIMITS } from './security.js';

export const DAEMON_URL = 'http://127.0.0.1:4317';

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
  const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    for (const byte of chunk) {
      if (byte === 10) lineBytes = 0;
      else if (++lineBytes > LIMITS.bodyBytes) { callback(new Error('MCP input line exceeds its limit.')); return; }
    }
    callback(null, chunk);
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
  const downstream = new StdioServerTransport(guard, output);
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  let handshake = Promise.resolve();
  let initializeId: string | number | undefined;
  let active = 0;
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
      finally { await upstream.close(); finish(); }
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
    void sent.catch(fail).finally(() => { active--; });
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
