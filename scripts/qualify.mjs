#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { repositoryRoot, npmCli, runNode } from '../tests/platform/runtime.mjs';

const arguments_ = process.argv.slice(2);
const allowed = new Set(['--output', '--system-browser', '--archive', '--suite']);
const options = {};
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index];
  const value = arguments_[index + 1];
  if (!allowed.has(key) || !value || value.startsWith('--')) {
    throw new Error('Usage: node scripts/qualify.mjs [--output DIRECTORY] [--system-browser ABSOLUTE_PATH] [--archive NPM_TARBALL] [--suite full|launcher|primitives]');
  }
  options[key] = value;
}
const suite = options['--suite'] ?? 'full';
if (!['full', 'launcher', 'primitives'].includes(suite)) throw new Error('Unknown qualification suite. Use full, launcher or primitives.');
if (suite === 'primitives' && !options['--archive']) throw new Error('Focused primitives qualification requires --archive; do not pack a changing source snapshot.');
const output = options['--output'] ? resolve(options['--output']) : await mkdtemp(join(tmpdir(), 'figma-qualification-'));
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'figma-package-smoke-'));
const report = { startedAt: new Date().toISOString(), platform: platform(), arch: arch(), osRelease: release(),
  node: process.version, browserMode: options['--system-browser'] ? 'system' : 'bundled',
  liveFigma: 'not tested; no credentials used', suite, steps: [], status: 'running' };
const npm = npmCli();
const env = { ...process.env, QUALIFY_OUTPUT: output };
if (options['--system-browser']) {
  env.QUALIFY_SYSTEM_BROWSER = resolve(options['--system-browser']);
  env.FIGMA_SERVER_TEST_BROWSER = env.QUALIFY_SYSTEM_BROWSER;
}

function step(name, execute) {
  const started = Date.now();
  try {
    const result = execute();
    report.steps.push({ name, status: 'passed', durationMs: Date.now() - started });
    return result;
  } catch (error) {
    report.steps.push({ name, status: 'failed', durationMs: Date.now() - started });
    throw error;
  }
}

try {
  let tarball;
  if (options['--archive']) tarball = resolve(options['--archive']);
  else {
    step('package unit tests and build', () => runNode([npm, 'test'], { env }));
    step('typecheck', () => runNode([npm, 'run', 'format:check'], { env }));
    const packs = JSON.parse(step('npm pack', () => runNode([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', work], { env, capture: true })));
    if (packs.length !== 1 || !packs[0].filename) throw new Error('npm pack did not return one archive.');
    tarball = join(work, packs[0].filename);
  }
  const bytes = await readFile(tarball);
  report.package = { filename: basename(tarball), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const consumer = join(work, 'consumer with spaces');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  step('install tarball without development dependencies', () => runNode([npm, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], { cwd: consumer, env }));
  const installed = join(consumer, 'node_modules', '@ctxrs', 'figma-server');
  const testEnv = { ...env, QUALIFY_PACKAGE_ROOT: installed, QUALIFY_CONSUMER: consumer, QUALIFY_ARCHIVE: tarball };
  if (suite !== 'primitives') {
    step('installed local and task-owned global npm launchers and stdio', () => runNode(['--test', join(repositoryRoot, 'tests/platform/launcher.test.mjs')], { cwd: consumer, env: testEnv }));
  }
  if (suite === 'full') {
    if (platform() === 'win32') {
      step('native NTFS owner-only ACL enforcement and rejection cases', () => runNode(['--test', join(repositoryRoot, 'tests/platform/windows-acl.test.mjs')], { cwd: consumer, env: testEnv }));
    }
    step('installed CLI and package contents', () => runNode(['--test', join(repositoryRoot, 'tests/platform/package.test.mjs')], { cwd: consumer, env: testEnv }));
    step('installed production API with real Chromium', () => runNode(['--test', join(repositoryRoot, 'tests/platform/browser.test.mjs')], { cwd: consumer, env: testEnv }));
    step('installed MCP and HTTP with real Chromium', () => runNode(['--test', join(repositoryRoot, 'tests/platform/api.test.mjs')], { cwd: consumer, env: testEnv }));
    if (process.env.QUALIFY_HEADED === '1') {
      step('installed headed login fixture and headless reopen', () => runNode(['--test', join(repositoryRoot, 'tests/platform/headed.test.mjs')], { cwd: consumer, env: testEnv }));
    }
  }
  if (suite === 'full' || suite === 'primitives') {
    step('installed upload, held modifiers and stdio frame limits with real Chromium', () => runNode(['--test', join(repositoryRoot, 'tests/platform/primitives.test.mjs')], { cwd: consumer, env: testEnv, timeout: 270_000 }));
    step('installed independent login deadlines with stdin open', () => runNode(['--test', join(repositoryRoot, 'tests/platform/login-deadline.test.mjs')], { cwd: consumer, env: testEnv }));
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  process.stderr.write(`Qualification failed: ${error.message}\n`);
  if (suite !== 'launcher' && platform() === 'linux' && !options['--system-browser']) {
    process.stderr.write('If Chromium reports "No usable sandbox", keep sandboxing enabled. On a host with working system Chrome, retry qualification with --system-browser /usr/bin/google-chrome. For a fresh app setup the supported configuration is figma-server init --browser /absolute/path/to/chrome. This is an explicit alternative mode, not a bundled-browser pass.\n');
  }
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(work, { recursive: true, force: true });
  process.stdout.write(`Qualification evidence: ${output}\n`);
}
