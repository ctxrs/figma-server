import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Core } from './core.js';
import { Fault, fault, publicError } from './errors.js';
import { LIMITS, accountName, checkHttpBoundary, isUploadRequest, isUploadInput } from './security.js';
import { toolSchemas, toolDescriptions } from './tools.js';

type McpSession = { transport: StreamableHTTPServerTransport; server: McpServer; touched: number; signals: Map<string | number, AbortSignal> };
type Login = { id: string; account: string; confirm: () => void; cancel: () => void; result: Promise<unknown>; timer: ReturnType<typeof setTimeout> };
export type HttpOptions = { port?: number; host?: '127.0.0.1' | '::1'; token: string; accounts: string[] };

async function body(req: IncomingMessage, maximum: number = LIMITS.bodyBytes, reserveLarge?: () => () => void, uploadOnly = false): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fault('content_type', 'Content-Type must be application/json.', 415);
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > maximum || !Number.isFinite(length)) fault('body_too_large', 'Request body is too large.', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  let release: (() => void) | undefined;
  try {
    if (length > LIMITS.bodyBytes) release = reserveLarge?.();
    for await (const chunk of req) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > maximum) fault('body_too_large', 'Request body is too large.', 413);
      if (size > LIMITS.bodyBytes && !release) release = reserveLarge?.();
      chunks.push(buffer);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { return fault('invalid_json', 'Request body must be valid JSON.'); }
    if (size > LIMITS.bodyBytes && !(uploadOnly ? isUploadInput(value, size) : isUploadRequest(value, size))) fault('body_too_large', 'Only image bytes with bounded metadata permit larger bodies.', 413);
    return value;
  } finally { release?.(); }
}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  // Early auth/size rejection must not leave an unread body framing another
  // request on this connection. Clients can reconnect with the same MCP session.
  if (status >= 400 && !res.req.complete) res.setHeader('Connection', 'close');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) fault('invalid_header', 'Repeated headers are not permitted.');
  return value;
}
export async function serve(core: Core, options: HttpOptions): Promise<{ url: string; close: () => Promise<void> }> {
  if (!/^[a-f0-9]{64}$/.test(options.token)) fault('invalid_secret', 'A private 32-byte bearer token is required.');
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') fault('unsafe_listen', 'V1 supports loopback only. Use a tunnel for remote access.');
  let expectedHost = '';
  let inFlight = 0;
  let largeBodies = 0;
  const reserveLarge = () => {
    if (largeBodies >= LIMITS.uploads) fault('upload_limit', 'Large upload body capacity is unavailable.', 429);
    largeBodies++;
    return () => { largeBodies--; };
  };
  let closing = false;
  const mcp = new Map<string, McpSession>();
  const logins = new Map<string, Login>();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    let admitted = false;
    const releaseAdmission = () => { if (admitted) { admitted = false; inFlight--; } };
    res.once('close', () => { if (!res.writableFinished) controller.abort(); releaseAdmission(); });
    void (async () => {
      checkHttpBoundary(header(req, 'host'), header(req, 'origin'), expectedHost, header(req, 'authorization'), options.token);
      if (closing) fault('shutting_down', 'Daemon is shutting down.', 503);
      if (inFlight >= LIMITS.queue) fault('request_limit', 'Request capacity is unavailable.', 429);
      inFlight++;
      admitted = true;
      try {
        if (!req.url || /[?#%]/.test(req.url)) fault('invalid_path', 'Request path is invalid.');
        const path = req.url;
        if (path === '/api/status' && req.method === 'GET') {
          send(res, 200, { accounts: options.accounts.map(a => core.browser.status(a)), ...core.status() as object }); return;
        }
        if (path === '/api/sessions' && req.method === 'POST') {
          z.object({}).strict().parse(await body(req));
          send(res, 201, { session: core.sessions.createSession() }); return;
        }
        if (path === '/api/sessions' && req.method === 'DELETE') {
          const id = header(req, 'x-figma-session');
          if (!id) fault('invalid_session', 'A session header is required.', 400);
          core.sessions.session(id);
          await core.sessions.closeSession(id); send(res, 200, { released: true }); return;
        }
        if (path.startsWith('/api/tools/') && req.method === 'POST') {
          const session = header(req, 'x-figma-session');
          if (!session) fault('invalid_session', 'X-Figma-Session is required.', 400);
          core.sessions.session(session);
          const upload = path === '/api/tools/figma.upload_image';
          const result = await core.call(session, path.slice('/api/tools/'.length), await body(req, upload ? LIMITS.uploadBodyBytes : LIMITS.bodyBytes, reserveLarge, upload), controller.signal);
          send(res, 200, result); return;
        }
        if (path.startsWith('/api/artifacts/') && req.method === 'GET') {
          const match = /^\/api\/artifacts\/(job_[a-f0-9-]{36})\/(before\.png|after\.png|screenshot\.png|export\.png)$/.exec(path);
          if (!match?.[1] || !match[2]) fault('invalid_artifact', 'Invalid artifact identifier.', 400);
          const session = header(req, 'x-figma-session');
          if (!session) fault('invalid_session', 'X-Figma-Session is required.', 400);
          core.sessions.session(session);
          const bytes = await core.artifacts.read(session, match[1], match[2]);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' });
          res.end(bytes); return;
        }
        if (path === '/api/login/start' && req.method === 'POST') {
          const input = z.object({ account: accountName }).strict().parse(await body(req));
          if (logins.size >= 1) fault('account_busy', 'Another login is active.', 409);
          core.browser.status(input.account);
          const id = randomUUID();
          let confirm!: () => void;
          let reject!: (error: unknown) => void;
          const confirmation = new Promise<void>((resolve, fail) => { confirm = resolve; reject = fail; });
          // A disconnect can precede browser launch / the confirmation callback.
          void confirmation.catch(() => undefined);
          let signalReady!: () => void;
          const ready = new Promise<void>(resolve => { signalReady = resolve; });
          const result = core.sessions.login(input.account, () => { signalReady(); return confirmation; });
          // Prevent unhandled rejection before the human confirms / polls.
          void result.catch(() => undefined);
          const timer = setTimeout(() => { reject(new Fault('login_timeout', 'Login timed out.', 409)); logins.delete(id); }, LIMITS.loginMs);
          const login = { id, account: input.account, confirm, cancel: () => reject(new Fault('login_cancelled', 'Login bootstrap was cancelled.', 409)), result, timer };
          logins.set(id, login);
          controller.signal.addEventListener('abort', login.cancel, { once: true });
          if (controller.signal.aborted) login.cancel();
          try {
            await Promise.race([ready, result]);
            // Only a completed 202 transfers cancellation ownership to the
            // client holding the login ID. An undelivered bootstrap must drain.
            let finished!: () => void;
            let disconnected!: () => void;
            try {
              await new Promise<void>((resolve, fail) => {
                finished = resolve;
                disconnected = () => fail(new Fault('login_cancelled', 'Login bootstrap response was disconnected.', 409));
                res.once('finish', finished);
                controller.signal.addEventListener('abort', disconnected, { once: true });
                if (controller.signal.aborted) disconnected();
                else send(res, 202, { login: id, account: input.account, state: 'authorizing' });
              });
            } finally {
              res.removeListener('finish', finished);
              controller.signal.removeEventListener('abort', disconnected);
            }
          } catch (error) {
            login.cancel();
            await result.catch(() => undefined);
            clearTimeout(timer); logins.delete(id); throw error;
          } finally { controller.signal.removeEventListener('abort', login.cancel); }
          return;
        }
        if (path === '/api/login/confirm' && req.method === 'POST') {
          const input = z.object({ login: z.string().uuid() }).strict().parse(await body(req));
          const login = logins.get(input.login);
          if (!login) fault('invalid_login', 'Login bootstrap is invalid.', 404);
          login.confirm();
          try { send(res, 200, await login.result); }
          finally { clearTimeout(login.timer); logins.delete(login.id); }
          return;
        }
        if (path === '/api/login/cancel' && req.method === 'POST') {
          const input = z.object({ login: z.string().uuid() }).strict().parse(await body(req));
          const login = logins.get(input.login);
          if (!login) fault('invalid_login', 'Login bootstrap is invalid.', 404);
          login.cancel();
          try { await login.result; } catch { /* Cancellation is expected; cleanup is awaited. */ }
          finally { clearTimeout(login.timer); logins.delete(login.id); }
          send(res, 200, { cancelled: true, account: login.account, status: core.browser.status(login.account) });
          return;
        }
        if (path !== '/mcp') fault('not_found', 'Unknown endpoint.', 404);
        if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) fault('method', 'Method not allowed.', 405);
        const id = header(req, 'mcp-session-id');
        let session = id ? mcp.get(id) : undefined;
        if (id) core.sessions.session(id);
        const payload = req.method === 'POST' ? await body(req, LIMITS.uploadBodyBytes, reserveLarge) : undefined;
        if (!session) {
          if (id) fault('invalid_session', 'MCP session is invalid or expired.', 404);
          if (req.method !== 'POST' || !isInitializeRequest(payload)) fault('initialize_required', 'Initialize an MCP session first.', 400);
          const coreId = core.sessions.createSession();
          const signals = new Map<string | number, AbortSignal>();
          const sdk = new McpServer({ name: 'figma-server', version: '0.1.0' });
          for (const [name, schema] of Object.entries(toolSchemas)) {
            sdk.registerTool(name, { description: toolDescriptions[name as keyof typeof toolDescriptions], inputSchema: schema }, async (args: unknown, extra: { signal: AbortSignal; requestId: string | number }) => {
              try {
                // Stable MCP preserves logical sessions across HTTP disconnects.
                // Explicit SDK cancellation, lease expiry and operation deadlines
                // close/quarantine the target, never a transient transport loss.
                const result = await core.call(coreId, name, args, extra.signal);
                const failed = typeof result === 'object' && result !== null && 'status' in result && ['failed', 'indeterminate'].includes(String(result.status));
                const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: JSON.stringify(result) }];
                if (['figma.screenshot', 'figma.export', 'figma.artifact_read'].includes(name)
                  && typeof result === 'object' && result !== null && 'artifact' in result && typeof result.artifact === 'string') {
                  const [, job, file] = result.artifact.split('/');
                  if (!job || !file) fault('invalid_artifact', 'Artifact reference is invalid.');
                  const bytes = await core.artifacts.read(coreId, job, file);
                  content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
                }
                return { content, isError: failed };
              } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify(publicError(error)) }], isError: true }; }
              finally {
                signals.delete(extra.requestId);
                if (extra.signal.aborted) {
                  // The SDK suppresses handler responses after cancellation.
                  // Complete the HTTP correlation explicitly after core cleanup,
                  // otherwise JSON-response promises retain request capacity forever.
                  await transport.send({ jsonrpc: '2.0', id: extra.requestId, error: { code: -32000, message: 'Request cancelled; target cleanup completed or quarantined.' } }).catch(() => undefined);
                }
              }
            });
          }
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => coreId, enableJsonResponse: true });
          try { await sdk.connect(transport); }
          catch (error) { await core.sessions.closeSession(coreId); throw error; }
          session = { server: sdk, transport, touched: Date.now(), signals };
          mcp.set(coreId, session);
          const onclose = transport.onclose;
          transport.onclose = () => { onclose?.(); mcp.delete(coreId); void core.sessions.closeSession(coreId); };
        }
        if (id) core.sessions.session(id);
        session.touched = Date.now();
        // SDK validates protocol versions, initialization, notifications, SSE
        // and deletion. Both adapters invoke the same core with a bound session.
        const requestId = payload && typeof payload === 'object' && 'id' in payload
          && (typeof payload.id === 'string' || typeof payload.id === 'number') ? payload.id : undefined;
        if (requestId !== undefined) {
          if (session.signals.has(requestId)) fault('duplicate_request', 'Request ID is already active.', 409);
          session.signals.set(requestId, controller.signal);
        }
        try { await session.transport.handleRequest(req, res, payload); }
        finally { if (requestId !== undefined) session.signals.delete(requestId); }
      } finally { releaseAdmission(); }
    })().catch(error => send(res, error instanceof Fault ? error.status : 400, { error: publicError(error) }));
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, host, () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') fault('listen_failed', 'Could not determine listener address.');
  expectedHost = host === '::1' ? `[::1]:${address.port}` : `${host}:${address.port}`;
  const sweep = setInterval(() => {
    void (async () => {
      for (const [id, session] of mcp) {
        if (session.touched + LIMITS.leaseMs < Date.now()) { await session.server.close(); mcp.delete(id); }
      }
      await core.sweep();
    })().catch(() => undefined);
  }, 10_000);
  sweep.unref();
  return { url: `http://${expectedHost}`, close: async () => {
    closing = true;
    clearInterval(sweep);
    for (const login of logins.values()) { clearTimeout(login.timer); login.cancel(); }
    await Promise.allSettled([...logins.values()].map(login => login.result));
    await Promise.allSettled([...mcp.values()].map(session => session.server.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
