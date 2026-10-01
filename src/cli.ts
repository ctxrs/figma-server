#!/usr/bin/env node
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { BrowserSupervisor, type BrowserBackend } from './browser-supervisor.js';
import { Core } from './core.js';
import { Fault, fault, publicError } from './errors.js';
import { serve } from './main.js';
import { accountName, LIMITS } from './security.js';
import { defaultRoot, Metadata, privateFile, State, type Config } from './state.js';
import { DAEMON_URL, stdioProxy } from './proxy.js';

const HELP = `figma-server — a dedicated Figma browser for your agent

Usage: figma-server <command>
  init [--browser PATH] [--probe-url URL]  Initialize; set browser while daemon is stopped
  browser-install                       Install the pinned full Chromium browser
  doctor                                Check setup and show recovery commands
  run                                   Keep the local daemon open in this terminal
  login [--account NAME]                 Sign in in the dedicated browser, then press Enter
  status                                Show account readiness and daemon status
  mcp                                   Connect an MCP agent over stdio

First run:
  figma-server init
  figma-server browser-install
  figma-server run
In another terminal:
  figma-server login
  figma-server status
Agent command: figma-server mcp (no token or environment setup needed)
`;

export type CliOptions = {
  state?: State; stdin?: Readable; stdout?: Writable; stderr?: Writable; signal?: AbortSignal;
  // Tests inject state and a browser backend; production paths and ownership stay fixed.
  browser?: (state: State, config: Config) => BrowserBackend;
  confirm?: () => Promise<void>;
  confirmationMs?: number;
};

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

async function request(state: State, path: string, options: { body?: object; signal?: AbortSignal; timeout?: number } = {}): Promise<unknown> {
  const token = await state.secret();
  let response: Response;
  try {
    response = await fetch(`${DAEMON_URL}${path}`, {
      method: options.body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(options.timeout ?? 3000), ...(options.signal ? [options.signal] : [])]),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Only a refused listener permits offline login. Timeouts or other HTTP
    // failures must not fall back to a second process opening the profile.
    if ((error as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED') {
      fault('daemon_offline', 'Daemon is not running. Keep figma-server run open in another terminal.', 503);
    }
    fault('daemon_unreachable', 'Daemon is not responding. Run figma-server doctor; check the existing daemon before restarting.', 503);
  }
  if (!response.ok) {
    if (response.status === 401) fault('unauthorized', 'Daemon authentication failed. Stop the daemon and run figma-server run using this OS account.', 401);
    const value: unknown = await response.json().catch(() => undefined);
    // Display only known core faults, never arbitrary HTTP response text.
    const code = (value as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (typeof code === 'string' && /^[a-z_]{1,50}$/.test(code)) fault(code, `Daemon rejected the request (${code}). Run figma-server status.`, response.status);
    fault('daemon_http_error', `Daemon returned HTTP ${response.status}. Run figma-server doctor.`, response.status);
  }
  return response.json() as Promise<unknown>;
}

function accountStatuses(value: unknown): { account: string; state: string }[] {
  const accounts = (value as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts)) fault('invalid_status', 'Daemon status was invalid. Stop it and run figma-server run.');
  return accounts.map(item => {
    if (!item || typeof item.account !== 'string' || !accountName.safeParse(item.account).success ||
      !['ready', 'authenticated_unverified', 'needs_login', 'permission_denied', 'consent_required', 'site_blocked', 'network_error',
        'ui_unsupported', 'crashed', 'stopped', 'starting', 'authorizing'].includes(item.state)) {
      fault('invalid_status', 'Daemon status was invalid. Stop it and run figma-server run.');
    }
    return { account: item.account as string, state: item.state as string };
  });
}

function showAccounts(value: unknown, output: Writable): void {
  for (const account of accountStatuses(value)) {
    output.write(`${account.account}: ${account.state}\n`);
    if (account.state === 'needs_login') output.write(`  Next: figma-server login --account ${account.account}\n`);
    if (account.state === 'authenticated_unverified') output.write('  Signed in. Ask your agent to open a Figma file to verify editor access.\n');
    if (account.state === 'crashed') output.write('  Next: stop the daemon with Ctrl+C, then run figma-server doctor and figma-server run.\n');
    if (account.state === 'ui_unsupported') output.write('  Editor readiness could not be verified. Check file access in figma-server login before retrying.\n');
    if (account.state === 'permission_denied') output.write('  Check file sharing permissions for this Figma account, then ask your agent to reopen the file.\n');
    if (account.state === 'consent_required') output.write(`  Next: figma-server login --account ${account.account}; complete the browser consent prompt.\n`);
    if (account.state === 'network_error' || account.state === 'site_blocked') output.write('  Check this machine can reach https://www.figma.com, then stop the daemon and run figma-server run.\n');
  }
}

export async function installBrowser(output: Writable, signal?: AbortSignal): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  output.write('Installing the pinned full Chromium browser…\n');
  await new Promise<void>((done, reject) => {
    const child = childProcess.spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}),
    });
    child.stdout?.on('data', chunk => output.write(chunk));
    child.stderr?.on('data', chunk => output.write(chunk));
    child.once('error', () => reject(new Fault('browser_install_failed', 'Browser installation could not start. Retry figma-server browser-install.')));
    child.once('close', code => code === 0 ? done() : reject(new Fault('browser_install_failed', 'Browser installation failed. Check network access and retry figma-server browser-install.')));
  });
  output.write('Chromium installed. Next: figma-server run\n');
}

async function initialize(state: State, browser: string | undefined, probeUrl: string | undefined, output: Writable): Promise<void> {
  if (browser) {
    if (!isAbsolute(browser)) fault('invalid_browser', 'Use an absolute executable path: figma-server init --browser /absolute/path/to/chromium');
    try {
      browser = await realpath(browser);
      await access(browser, constants.X_OK);
      if (!(await stat(browser)).isFile()) throw new Error();
    }
    catch { fault('invalid_browser', 'Browser executable is missing or not executable. Use figma-server init --browser with an absolute executable path.'); }
  }
  let config: Config;
  let existed = false;
  try { config = await state.config(); existed = true; }
  catch (error) {
    if (!missing(error)) throw error;
    config = { version: 1, ...(browser ? { browser } : {}), accounts: [{ name: 'default', loginOrigins: [], ...(probeUrl ? { probeUrl } : {}) }] };
  }
  if (existed && probeUrl && config.accounts[0]?.probeUrl !== probeUrl) {
    fault('already_initialized', `Existing settings were preserved. Edit ${state.path('config.json')} to change the probe URL, then run figma-server doctor.`);
  }
  let updated = false;
  if (existed && browser && config.browser !== browser) {
    const unlock = await state.lock();
    const temporary = state.path(`config.${randomBytes(16).toString('hex')}.tmp`);
    try {
      // Re-read under the daemon/profile lock, preserving every other setting.
      config = await state.config();
      await state.secret();
      if (probeUrl && config.accounts[0]?.probeUrl !== probeUrl) {
        fault('already_initialized', `Existing settings were preserved. Edit ${state.path('config.json')} to change the probe URL, then run figma-server doctor.`);
      }
      config = { ...config, browser };
      state.validate(config);
      await privateFile(temporary, JSON.stringify(config, null, 2) + '\n');
      await rename(temporary, state.path('config.json'));
      updated = true;
    } finally {
      try { await rm(temporary, { force: true }); }
      finally { await unlock(); }
    }
  }
  try { await state.init(config); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Repair an interrupted init without ever overwriting configuration or a token.
  await state.config();
  try { await state.secret(); }
  catch (error) {
    if (!missing(error)) throw error;
    try { await privateFile(state.path('secret'), randomBytes(32).toString('hex') + '\n'); }
    catch (creation) { if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation; }
    await state.secret();
  }
  output.write(`${updated ? 'Updated browser' : existed ? 'Already initialized' : 'Initialized'}: ${state.root}\n`);
  output.write(`Next: ${config.browser ? 'figma-server run' : 'figma-server browser-install'}\n`);
}

async function doctor(state: State, output: Writable, signal?: AbortSignal): Promise<number> {
  const config = await state.config();
  await state.secret();
  output.write(`Private state: OK (${state.root})\n`);
  let healthy = true;
  try {
    const path = config.browser ?? chromium.executablePath();
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) throw new Error();
    output.write(`Chromium: found (${path}); launch and sandbox support are checked by figma-server run.\n`);
  } catch {
    healthy = false;
    output.write(config.browser
      ? `Chromium: missing. Set an absolute executable path in ${state.path('config.json')}, then run figma-server doctor.\n`
      : 'Chromium: missing. Next: figma-server browser-install\n');
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    output.write('Login display: unavailable. Run figma-server login from a graphical desktop session on this machine.\n');
  }
  try {
    await privateFile(state.path('daemon.lock'));
    const lock: unknown = JSON.parse(await readFile(state.path('daemon.lock'), 'utf8'));
    const pid = (lock as { pid?: unknown } | null)?.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error();
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    output.write(`Profile lock: PID ${pid} ${alive ? 'is present' : 'has exited'}.\n`);
    if (!alive) {
      healthy = false;
      output.write(`Confirm this PID and browsers using the dedicated profile are stopped; manually remove ${state.path('daemon.lock')}, then run figma-server run.\n`);
    }
  } catch (error) { if (!missing(error)) throw error; }
  try { showAccounts(await request(state, '/api/status', { signal }), output); output.write(`Daemon: connected (${DAEMON_URL})\n`); }
  catch (error) {
    if (!(error instanceof Fault) || error.code !== 'daemon_offline') throw error;
    healthy = false;
    output.write('Daemon: stopped. Next: figma-server run\n');
  }
  return healthy ? 0 : 1;
}

async function run(state: State, options: CliOptions, output: Writable): Promise<void> {
  const config = await state.config();
  const token = await state.secret();
  const unlock = await state.lock();
  let metadata: Metadata | undefined;
  let core: Core | undefined;
  let browser: BrowserBackend | undefined;
  let daemon: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    options.signal?.throwIfAborted();
    metadata = await Metadata.open(state);
    browser = options.browser?.(state, config) ?? new BrowserSupervisor(state, config);
    core = new Core(browser, state, metadata);
    await browser.start();
    options.signal?.throwIfAborted();
    daemon = await serve(core, { token, accounts: config.accounts.map(a => a.name) });
    output.write(`Figma daemon ready at ${daemon.url}. Keep this terminal open; Ctrl+C stops it.\n`);
    output.write('Next: figma-server login (another terminal). Agent command: figma-server mcp\n');
    await new Promise<void>(done => {
      if (options.signal?.aborted) done();
      else options.signal?.addEventListener('abort', () => done(), { once: true });
    });
  } finally {
    output.write('Stopping Figma daemon…\n');
    try { await daemon?.close(); }
    finally {
      // Keep the profile locked if browser teardown cannot be confirmed.
      if (core) await core.stop();
      else { await browser?.stop(); metadata?.close(); }
      await unlock();
    }
  }
}

async function login(state: State, account: string, options: CliOptions, output: Writable): Promise<void> {
  const config = await state.config();
  if (!config.accounts.some(value => value.name === account)) fault('unknown_account', `Account is not configured. Check ${state.path('config.json')}, then run figma-server doctor.`);
  const input = options.stdin ?? process.stdin;
  if (!options.confirm && !(input as NodeJS.ReadStream).isTTY) {
    fault('interactive_login_required', `Login needs a human terminal. Run figma-server login --account ${account} in a graphical desktop terminal; sign in in the browser.`);
  }
  const confirm = options.confirm ?? (async (signal?: AbortSignal) => {
    const prompt = createInterface({ input, output });
    let onClose!: () => void;
    const closed = new Promise<never>((_, reject) => {
      onClose = () => reject(new Fault('login_interrupted', 'Login terminal closed before confirmation. Run figma-server login again.'));
      prompt.once('close', onClose);
    });
    try { await Promise.race([prompt.question('Finish signing in in the browser, then press Enter here: ', { signal }), closed]); }
    finally { prompt.off('close', onClose); prompt.close(); }
  });
  // The daemon cannot push an expired login to a terminal waiting for Enter.
  // Start a local deadline only when the browser is ready for the human.
  const confirmation = async (): Promise<void> => {
    output.write('Sign in only in the dedicated browser window. Never enter a password in this terminal.\n');
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const timer = setTimeout(() => deadline.abort(new Fault('login_timeout', 'Login timed out. Run figma-server login again to retry.', 409)), options.confirmationMs ?? LIMITS.loginMs);
    let abort!: () => void;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      await Promise.race([cancelled, confirm(signal)]);
      signal.throwIfAborted();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  };
  try {
    await request(state, '/api/status', { signal: options.signal });
  } catch (error) {
    if (!(error instanceof Fault) || error.code !== 'daemon_offline') throw error;
    const unlock = await state.lock();
    let browser: BrowserBackend | undefined;
    try {
      browser = options.browser?.(state, config) ?? new BrowserSupervisor(state, config);
      output.write(`Opening exclusive login for ${account}…\n`);
      const result = await browser.login(account, confirmation);
      showAccounts({ accounts: [result] }, output);
    } finally { await browser?.stop(); await unlock(); }
    output.write('Login profile saved. Next: figma-server run\n');
    return;
  }
  const started = await request(state, '/api/login/start', { body: { account }, signal: options.signal, timeout: 45_000 });
  const id = (started as { login?: unknown } | null)?.login;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fault('invalid_login', 'Daemon login response was invalid. Restart the daemon before retrying login.');
  output.write(`Daemon opened exclusive login for ${account}. Active account leases were released.\n`);
  let completed = false;
  try {
    await confirmation();
    const result = await request(state, '/api/login/confirm', { body: { login: id }, signal: options.signal, timeout: 90_000 });
    options.signal?.throwIfAborted();
    showAccounts({ accounts: [result] }, output);
    completed = true;
  } finally {
    if (!completed) {
      try {
        // The command's signal may already be aborted. Cleanup gets its own
        // bounded request and must settle before the CLI exits.
        const result = await request(state, '/api/login/cancel', { body: { login: id }, timeout: 5000 });
        const cancelled = result as { cancelled?: unknown; account?: unknown; status?: unknown } | null;
        if (cancelled?.cancelled !== true || cancelled.account !== account) throw new Error('Unconfirmed cleanup');
        const status = accountStatuses({ accounts: [cancelled.status] })[0]!;
        if (status.account !== account || status.state === 'authorizing' || status.state === 'starting') throw new Error('Unconfirmed cleanup');
        output.write('Login interrupted; daemon login cleanup completed.\n');
      } catch {
        output.write('Login cleanup could not be confirmed. Stop the daemon with Ctrl+C before retrying login.\n');
      }
    }
  }
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const state = options.state ?? new State(defaultRoot());
  const command = args[0];
  try {
    if (!command || command === '--help' || command === '-h') { stdout.write(HELP); return 0; }
    const commands = ['init', 'browser-install', 'doctor', 'run', 'login', 'status', 'mcp'];
    if (!commands.includes(command)) fault('usage', 'Unknown command. Run figma-server --help.');
    const { values, positionals } = parseArgs({ args: args.slice(1), strict: true, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' },
      ...(command === 'init' ? { browser: { type: 'string' as const }, 'probe-url': { type: 'string' as const } } : {}),
      ...(command === 'login' ? { account: { type: 'string' as const } } : {}),
    } });
    if (positionals.length && !(command === 'mcp' && positionals.length === 1 && positionals[0] === 'stdio')) fault('usage', 'Unexpected arguments. Run figma-server --help.');
    if (values.help) { (command === 'mcp' ? stderr : stdout).write(HELP); return 0; }
    options.signal?.throwIfAborted();
    switch (command) {
      case 'init': await initialize(state, values.browser as string | undefined, values['probe-url'] as string | undefined, stdout); break;
      case 'browser-install': await installBrowser(stderr, options.signal); break;
      case 'doctor': return await doctor(state, stdout, options.signal);
      case 'status': await state.config(); showAccounts(await request(state, '/api/status', { signal: options.signal }), stdout); break;
      case 'run': await run(state, options, stderr); break;
      case 'login': {
        const confirmation = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, confirmation.signal]) : confirmation.signal;
        try { await login(state, accountName.parse(values.account ?? 'default'), { ...options, signal }, stderr); }
        finally {
          // A backend deadline can win its Promise.race while readline still
          // awaits Enter. Release that question and its stdin handle on any exit.
          confirmation.abort();
        }
        break;
      }
      case 'mcp': await stdioProxy(state, { ...options, stdin: options.stdin, stdout, stderr }); break;
    }
    return 0;
  } catch (error) {
    if (options.signal?.aborted && (error === options.signal.reason || (error instanceof Error && error.name === 'AbortError'))) return 0;
    const code = (error as NodeJS.ErrnoException)?.code;
    let message: string;
    if (missing(error)) message = 'Setup is incomplete. Run figma-server init, then figma-server doctor.';
    else if (code === 'EADDRINUSE') message = 'Port 4317 is already in use. Run figma-server status; stop the existing owner before running a second daemon.';
    else if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) message = 'Invalid command options. Run figma-server --help.';
    else if (error instanceof Fault) message = error.message;
    else if (error instanceof Error && error.name === 'ZodError') message = `Invalid account, URL or configuration. Check ${state.path('config.json')} and run figma-server --help.`;
    else message = `${publicError(error).message} Run figma-server doctor.`;
    stderr.write(`${message}\n`);
    if (error instanceof Fault && error.code === 'daemon_locked') stderr.write('Next: figma-server doctor (inspect the lock owner before removing anything).\n');
    if (error instanceof Fault && error.code === 'browser_start_failed') stderr.write('Next: figma-server doctor. If bundled Chromium is blocked, stop the daemon and run figma-server init --browser /absolute/path/to/chromium, then figma-server run. Keep the sandbox enabled.\n');
    if (error instanceof Fault && error.code === 'unsafe_permissions') {
      stderr.write(`Next: restore owner-only permissions under ${state.root} (directories 0700, files 0600), then run figma-server doctor.\n`);
    }
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
