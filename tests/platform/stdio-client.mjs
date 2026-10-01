import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { packageRoot } from './runtime.mjs';

const require = createRequire(join(packageRoot, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { ReadBuffer, serializeMessage } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/shared/stdio.js')).href);

// Exact installed npm launcher; no SDK process-kill fallback can count as EOF.
export async function installedStdio({ shim, cwd, env }) {
  let command = shim, args = ['mcp'], options = {};
  if (process.platform === 'win32') {
    assert.doesNotMatch(shim, /["%\r\n!&|<>^]/);
    command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe');
    args = ['/d', '/s', '/c', `""${shim}" mcp"`];
    options = { windowsVerbatimArguments: true };
  }
  let child, exited, diagnostics = '';
  const errors = [], buffer = new ReadBuffer();
  const transport = {
    async start() {
      child = spawn(command, args, { ...options, cwd, env, windowsHide: true, stdio: 'pipe' });
      exited = once(child, 'close'); void exited.catch(() => {});
      child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
      child.stdout.on('data', chunk => {
        try {
          buffer.append(chunk);
          let message;
          while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message);
        } catch (error) { errors.push(error); transport.onerror?.(error); }
      });
      child.on('error', error => transport.onerror?.(error));
      child.once('close', () => transport.onclose?.());
      await once(child, 'spawn');
    },
    async send(message) { if (!child.stdin.write(serializeMessage(message))) await once(child.stdin, 'drain'); },
    async close() { child?.stdin.end(); },
  };
  const client = new Client({ name: 'installed-primitives-qualification', version: '1.0.0' });
  const connection = { client, errors, diagnostics: () => diagnostics,
    async exit({ eof = false } = {}) {
      if (eof) child.stdin.end();
      return Promise.race([exited, new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Installed stdio launcher did not exit naturally (EOF=${eof}, exitCode=${child.exitCode}, signal=${child.signalCode}); ${diagnostics}`)), 10_000).unref();
      })]);
    },
    async cleanup() {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (exited) await exited;
      await client.close();
    },
  };
  try { await client.connect(transport); return connection; }
  catch (error) { await connection.cleanup(); throw error; }
}
