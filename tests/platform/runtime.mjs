import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const packageRoot = process.env.QUALIFY_PACKAGE_ROOT ?? repositoryRoot;
export const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
export const productionDirectory = dirname(join(packageRoot, packageManifest.bin['figma-server']));

export async function productionModule(name) {
  return import(pathToFileURL(join(productionDirectory, `${name}.js`)).href);
}

// Invoke npm's JavaScript CLI directly: no cmd.exe quoting or shell expansion.
export function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const executable = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (existsSync(executable)) {
      candidates.push(process.platform === 'win32'
        ? join(directory, 'node_modules/npm/bin/npm-cli.js') : realpathSync(executable));
    }
  }
  const candidate = candidates.find(path => path && path.endsWith('npm-cli.js') && existsSync(path));
  if (!candidate) throw new Error('npm-cli.js not found; install Node with npm and put it on PATH.');
  return candidate;
}

export function runNode(args, { cwd = repositoryRoot, env = process.env, capture = false, timeout = 180_000, expectedStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, env, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`Node command exited ${result.status ?? result.signal}: ${args[0]}`);
  }
  return result.stdout ?? '';
}
