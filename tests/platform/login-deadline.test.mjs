import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { productionModule, repositoryRoot } from './runtime.mjs';

const { State } = await productionModule('state');

test('installed login deadlines release readline and exit with stdin still open', { timeout: 60_000 }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'figma login deadline-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const results = [];
  for (const mode of ['offline', 'daemon']) {
    const state = new State(join(work, mode));
    await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }] });
    const child = spawn(process.execPath, [join(repositoryRoot, 'tests/platform/login-deadline-child.mjs')], {
      env: { ...process.env, QUALIFY_LOGIN_MODE: mode, QUALIFY_LOGIN_ROOT: state.root, QUALIFY_LOGIN_EVIDENCE: work },
      stdio: 'pipe', windowsHide: true,
    });
    const closed = once(child, 'close'); void closed.catch(() => {});
    let diagnostics = '', stdout = '';
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    try {
      const result = await Promise.race([closed, new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${mode} login did not exit naturally with stdin open`)), 20_000).unref();
      })]);
      assert.deepEqual(result, [1, null]);
      assert.equal(child.stdin.writableEnded, false, 'Neither Enter nor stdin EOF may make the fixture pass.');
      assert.equal(stdout, ''); assert.match(diagnostics, /timed out/i);
      const evidence = JSON.parse(await readFile(join(work, mode + '.json'), 'utf8'));
      assert.equal(evidence.code, 1); assert.equal(evidence.paused, true); assert.equal(evidence.dataListeners, 0);
      assert.equal(evidence.stopped, true);
      if (mode === 'daemon') {
        assert.equal(evidence.expired, true, 'Backend deadline must expire independently before the CLI deadline.');
        assert.match(diagnostics, /daemon login cleanup completed/);
      } else {
        await assert.rejects(access(state.path('daemon.lock')), error => error.code === 'ENOENT');
        const unlock = await state.lock(); await unlock();
      }
      results.push({ ...evidence, stdinLeftOpen: true, naturalExit: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }
  if (process.env.QUALIFY_OUTPUT) {
    await mkdir(process.env.QUALIFY_OUTPUT, { recursive: true });
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'login-deadline.json'), JSON.stringify({
      platform: process.platform, node: process.version, results,
      scope: 'Installed runCli, real open stdin/readline, injected TTY gate and short deadlines; inert login backend, no GUI/authentication claim.',
    }, null, 2) + '\n');
  }
});
