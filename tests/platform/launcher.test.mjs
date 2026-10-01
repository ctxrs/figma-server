import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { productionModule, packageRoot, npmCli, runNode } from './runtime.mjs';

const require = createRequire(join(packageRoot, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { ReadBuffer, serializeMessage } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/shared/stdio.js')).href);
const { State, Metadata } = await productionModule('state');
const { Core } = await productionModule('core');
const { serve } = await productionModule('main');

function invocation(shim, args) {
  if (process.platform !== 'win32') return { command: shim, args, options: {} };
  // Explicit cmd.exe is the Windows launcher; never execute a .ps1 or weaken
  // ExecutionPolicy. Controlled paths include spaces; reject shell metacharacters.
  assert.doesNotMatch(shim, /["%\r\n!&|<>^]/);
  assert.ok(args.every(arg => /^[a-z-]+$/.test(arg)));
  return { command: process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'),
    args: ['/d', '/s', '/c', `""${shim}" ${args.join(' ')}"`], options: { windowsVerbatimArguments: true } };
}

test('actual local and task-owned global npm shims: help, MCP handshake and natural EOF cleanup', { timeout: 180_000 }, async t => {
  assert.ok(process.env.QUALIFY_CONSUMER && process.env.QUALIFY_ARCHIVE, 'Run through scripts/qualify.mjs with an archive.');
  const work = await realpath(await mkdtemp(join(tmpdir(), 'figma launchers-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const prefix = join(work, 'global prefix with spaces');
  const installHome = join(work, 'npm home');
  await mkdir(installHome, { mode: 0o700 });
  const installEnv = { ...process.env, HOME: installHome, USERPROFILE: installHome,
    npm_config_cache: join(work, 'npm cache'), npm_config_userconfig: join(work, 'empty-npmrc') };
  await writeFile(installEnv.npm_config_userconfig, '');
  runNode([npmCli(), 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    process.env.QUALIFY_ARCHIVE], { cwd: work, env: installEnv });
  const suffix = process.platform === 'win32' ? 'figma-server.cmd' : 'figma-server';
  const launchers = [
    { kind: 'local', shim: join(process.env.QUALIFY_CONSUMER, 'node_modules/.bin', suffix), args: ['mcp'] },
    { kind: 'global', shim: join(prefix, process.platform === 'win32' ? '' : 'bin', suffix), args: ['mcp', 'stdio'] },
  ];
  const results = [];
  for (const launcher of launchers) {
    const home = join(work, launcher.kind + ' home');
    await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
    const sync = args => {
      const call = invocation(launcher.shim, args);
      const result = spawnSync(call.command, call.args, { ...call.options, cwd: home, env, windowsHide: true,
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, 'Installed npm shim must exit successfully.');
      return result.stdout;
    };
    assert.match(sync(['--help']), /Usage|figma-server/);
    assert.match(sync(['init']), /Initialized/);
    const root = process.platform === 'win32' ? join(home, 'AppData/Local/figma-server')
      : process.platform === 'darwin' ? join(home, 'Library/Application Support/figma-server') : join(home, '.figma-server');
    const state = new State(root);
    const token = await state.secret();
    const tabs = [];
    // This test qualifies launcher/transport wiring. Real-browser behavior has
    // its own fixtures; no browser or live Figma is needed to observe lease cleanup.
    const backend = { status: () => ({ account: 'default', state: 'ready', generation: 'launcher-fixture' }),
      open: async () => {
        const tab = { target: randomUUID(), generation: 'launcher-fixture', closed: false,
          check: async () => {}, close: async () => { tab.closed = true; } };
        tabs.push(tab); return tab;
      }, stop: async () => {} };
    const core = new Core(backend, state, await Metadata.open(state));
    let daemon;
    let child;
    let client;
    try {
      // The proxy's public daemon port is fixed. EADDRINUSE is a blocked probe;
      // never stop, reuse or send our token to an operator's daemon.
      daemon = await serve(core, { token, accounts: ['default'] });
      const buffer = new ReadBuffer();
      let diagnostics = '';
      const parserErrors = [];
      let exited;
      const call = invocation(launcher.shim, launcher.args);
      const transport = {
        async start() {
          child = spawn(call.command, call.args, { ...call.options, cwd: home, env, windowsHide: true, stdio: 'pipe' });
          exited = once(child, 'close');
          void exited.catch(() => {});
          child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
          child.stdout.on('data', chunk => {
            try {
              buffer.append(chunk);
              let message;
              while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message);
            } catch (error) { parserErrors.push(error); transport.onerror?.(error); }
          });
          child.on('error', error => transport.onerror?.(error));
          child.once('close', () => transport.onclose?.());
          await once(child, 'spawn');
        },
        async send(message) { if (!child.stdin.write(serializeMessage(message))) await once(child.stdin, 'drain'); },
        async close() { child?.stdin.end(); },
      };
      client = new Client({ name: 'npm-shim-qualification', version: '1.0.0' });
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'figma.open'));
      const status = await client.callTool({ name: 'figma.account_status', arguments: { account: 'default' } });
      assert.ok(!status.isError);
      const opened = await client.callTool({ name: 'figma.open', arguments: {
        account: 'default', file_url: 'https://www.figma.com/design/LauncherFixture01', mode: 'read',
      } });
      assert.ok(!opened.isError);
      assert.equal(core.sessions.sessions.size, 1);
      assert.equal(core.sessions.leases.size, 1);
      // End stdin directly. No SDK timeout or forced process kill can count as
      // EOF success; both the shell and Node must naturally exit with code zero.
      child.stdin.end();
      const [code, signal] = await Promise.race([exited,
        new Promise((_, reject) => { setTimeout(() => reject(new Error('npm shim did not exit on EOF')), 15_000).unref(); })]);
      assert.equal(code, 0); assert.equal(signal, null);
      assert.equal(parserErrors.length, 0, 'All stdout must be valid MCP JSON-RPC.');
      assert.equal(core.sessions.sessions.size, 0);
      assert.equal(core.sessions.leases.size, 0);
      assert.ok(tabs.every(tab => tab.closed));
      assert.ok(!diagnostics.includes(token), 'No private bearer token on stderr.');
      results.push({ kind: launcher.kind, help: true, initializedViaShim: true,
        mcpArguments: launcher.args, handshake: true, EOFExit: 0, remainingSessions: 0, remainingLeases: 0 });
    } finally {
      await client?.close();
      if (child && child.exitCode === null) child.kill();
      await daemon?.close();
      await core.stop();
    }
  }
  if (process.env.QUALIFY_OUTPUT) {
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'launcher.json'), JSON.stringify({
      platform: process.platform, node: process.version,
      windowsLauncher: process.platform === 'win32' ? 'cmd.exe /d /s /c; npm .cmd shim' : null,
      globalInstall: 'Task-owned --global --prefix; operator global configuration untouched.',
      browser: 'Inert backend only; transport/launcher scope.', runs: results,
    }, null, 2) + '\n');
  }
});
