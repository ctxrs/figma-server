#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { repositoryRoot } from '../tests/platform/runtime.mjs';

const [candidateArgument, outputArgument, suiteFlag, suiteArgument] = process.argv.slice(2);
const suite = suiteArgument ?? 'full';
if (!candidateArgument || !outputArgument || ![4, 6].includes(process.argv.length)
  || (suiteFlag && suiteFlag !== '--suite') || !['full', 'primitives'].includes(suite)) {
  throw new Error('Usage: node scripts/qualify-windows-bundle.mjs candidate.tgz OUTPUT_DIRECTORY [--suite full|primitives]');
}
const candidate = resolve(candidateArgument);
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(tmpdir(), 'figma-windows-bundle-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  const index = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
  const runtimes = [];
  for (const major of [22, 24]) {
    const version = index.find(entry => entry.version.startsWith(`v${major}.`))?.version;
    if (!version || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`Node ${major} version not found.`);
    const filename = `node-${version}-win-x64.zip`;
    const base = `https://nodejs.org/dist/${version}/`;
    const sums = (await download(base + 'SHASUMS256.txt')).toString();
    const checksum = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === filename)?.[0];
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Official Node checksum not found.');
    const cached = join(output, filename);
    let bytes;
    let downloaded = false;
    try { bytes = await readFile(cached); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = await download(base + filename);
      downloaded = true;
    }
    if (hash(bytes) !== checksum) throw new Error('Portable Node digest mismatch.');
    if (downloaded) await writeFile(cached, bytes);
    await copyFile(cached, join(stage, filename));
    runtimes.push({ major, filename, directory: filename.slice(0, -4), sha256: checksum });
  }
  const filename = basename(candidate);
  await copyFile(candidate, join(stage, filename));
  const candidateInfo = { filename, sha256: hash(await readFile(candidate)), suite };
  await writeFile(join(stage, 'candidate.json'), JSON.stringify(candidateInfo, null, 2) + '\n');
  await writeFile(join(stage, 'windows-runtimes.json'), JSON.stringify(runtimes, null, 2) + '\n');
  await mkdir(join(stage, 'scripts'));
  await mkdir(join(stage, 'tests/platform'), { recursive: true });
  await copyFile(join(repositoryRoot, 'package.json'), join(stage, 'package.json'));
  await copyFile(join(repositoryRoot, 'scripts/qualify.mjs'), join(stage, 'scripts/qualify.mjs'));
  for (const name of await readdir(join(repositoryRoot, 'tests/platform'))) {
    // The lab recursively requires exactly one run-replay.ps1 entry.
    if (name.endsWith('.mjs')) await copyFile(join(repositoryRoot, 'tests/platform', name), join(stage, 'tests/platform', name));
  }
  await copyFile(join(repositoryRoot, 'tests/platform/run-replay.ps1'), join(stage, 'run-replay.ps1'));
  const archive = join(output, 'windows-qualification.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', stage, '.'], { stdio: 'inherit', timeout: 60_000 });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error('Qualification tar creation failed.');
  const info = { archive, sha256: hash(await readFile(archive)), candidate: candidateInfo, runtimes };
  await writeFile(join(output, 'windows-bundle.json'), JSON.stringify(info, null, 2) + '\n');
  process.stdout.write(JSON.stringify(info, null, 2) + '\n');
} finally { await rm(stage, { recursive: true, force: true }); }
