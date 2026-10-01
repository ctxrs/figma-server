import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionModule } from './runtime.mjs';
import { firstKey, file, launchFixture } from './fixture.mjs';

const { State } = await productionModule('state');
const { BrowserSupervisor } = await productionModule('browser-supervisor');

test('headed login bootstrap closes and reopens its dedicated profile headlessly', { timeout: 60_000 }, async t => {
  if (process.platform === 'linux') assert.ok(process.env.DISPLAY, 'Use xvfb-run -a for this explicit headed fixture.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma-headed-fixture-')));
  const state = new State(root);
  const config = { version: 1, accounts: [{ name: 'default', loginOrigins: [], probeUrl: file(firstKey) }],
    ...(process.env.QUALIFY_SYSTEM_BROWSER ? { browser: process.env.QUALIFY_SYSTEM_BROWSER } : {}) };
  await state.init(config);
  const launches = [];
  const supervisor = new BrowserSupervisor(state, config, async (profile, options) => {
    launches.push({ profile, headless: options.headless });
    return launchFixture(profile, options);
  });
  const unlock = await state.lock();
  t.after(async () => { await supervisor.stop(); await unlock(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(new State(root).lock(), error => error.code === 'daemon_locked');
  const result = await supervisor.login('default', async () => {
    assert.equal(supervisor.status('default').state, 'authorizing');
    const worker = supervisor.workers.get('default');
    assert.equal(worker.headed, true);
    const page = worker.context.pages().find(candidate => candidate.url() === 'https://www.figma.com/login');
    assert.ok(page, 'Headed context must survive until its login page opens.');
    await page.getByLabel('Email').waitFor();
    await assert.rejects(supervisor.open('default', file(firstKey), firstKey), error => error.code === 'account_busy');
    // This confirmation uses an intercepted fixture, not a real login.
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(launches.map(launch => launch.headless), [false, true]);
  assert.equal(launches[0].profile, launches[1].profile);
  assert.equal(supervisor.workers.get('default').headed, false);
  if (process.env.QUALIFY_OUTPUT) {
    await mkdir(process.env.QUALIFY_OUTPUT, { recursive: true });
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'headed.json'), JSON.stringify({
      headedLaunch: true, headlessReopen: true, sameDedicatedProfile: true, exclusiveProfileLock: true,
      liveFigmaLogin: false, evidence: 'Real graphical Chromium under a local intercepted fixture; no credentials.',
    }, null, 2) + '\n');
  }
});
