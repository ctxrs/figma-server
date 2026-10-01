import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { z } from 'zod';
import { accountName, fileUrl, httpsUrl, LIMITS } from './security.js';
import { fault } from './errors.js';

export const configSchema = z.object({
  version: z.literal(1), browser: z.string().min(1).optional(),
  accounts: z.array(z.object({ name: accountName, probeUrl: z.string().optional(),
    loginOrigins: z.array(z.string()).max(8).default([]) }).strict()).min(1).max(4),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function defaultRoot(): string {
  // Deliberately fixed: no arbitrary profile/data-root flags or environment overrides.
  const home = homedir();
  return process.platform === 'win32' ? join(home, 'AppData', 'Local', 'figma-server')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'figma-server')
    : join(home, '.figma-server');
}

async function checkAncestors(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fault('unsafe_path', 'State path must be canonical and absolute.');
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fault('unsafe_path', 'State directories cannot be symlinks or alternate paths.');
      if (process.platform !== 'win32') {
        const own = info.uid === process.getuid?.() || info.uid === 0;
        const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if (!own || ((info.mode & 0o022) !== 0 && !stickyRoot)) {
          fault('untrusted_ancestry', 'State ancestry must be owned by this user or root and not replaceable by other users.');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

const protectedWindowsPaths = new Map<string, { identity: string; operation: Promise<void> }>();
async function windowsPrivate(path: string): Promise<void> {
  const info = await lstat(path);
  const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  const previous = protectedWindowsPaths.get(path);
  if (previous?.identity === identity) return previous.operation;
  // The owner-only root excludes other users; same-user processes and OS admins
  // are the trust boundary. Reapply for replaced files without spawning PowerShell
  // for every screenshot chunk or lease heartbeat on the same protected inode.
  const operation = enforceWindowsPrivate(path);
  if (protectedWindowsPaths.size >= 4096) protectedWindowsPaths.clear();
  protectedWindowsPaths.set(path, { identity, operation });
  try { await operation; }
  catch (error) { protectedWindowsPaths.delete(path); throw error; }
}

async function enforceWindowsPrivate(path: string): Promise<void> {
  // chmod does not protect NTFS. The fixed user-profile ancestry and privileged
  // OS administrators are trusted; this DACL permits only the current SID.
  // Pass paths as data in a minimal environment, never as shell source.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const script = `$ErrorActionPreference='Stop';
    $p=$env:FIGMA_SERVER_ACL_PATH;
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $item=Get-Item -LiteralPath $p -Force;
    if($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint){throw 'reparse point'};
    $old=Get-Acl -LiteralPath $p;
    $owner=$old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    if($owner -ne $sid.Value -and $owner -ne 'S-1-5-32-544'){throw 'foreign owner'};
    if($item.PSIsContainer){
      $acl=[System.Security.AccessControl.DirectorySecurity]::new();
      $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';
    }else{
      $acl=[System.Security.AccessControl.FileSecurity]::new();
      $inherit=[System.Security.AccessControl.InheritanceFlags]::None;
    };
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);
    $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl;`;
  try {
    await promisify(execFile)(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4096,
        env: { SystemRoot: systemRoot, FIGMA_SERVER_ACL_PATH: path } });
  } catch { fault('unsafe_permissions', 'Could not enforce current-user-only NTFS permissions. State access is blocked.'); }
}

export async function privateDirectory(path: string): Promise<void> {
  await checkAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fault('unsafe_path', 'A private directory is required.');
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid?.()) fault('unsafe_owner', 'The state directory must belong to the current user.');
    if ((info.mode & 0o077) !== 0) fault('unsafe_permissions', 'State directories require mode 0700.');
  } else await windowsPrivate(path);
}

export async function privateFile(path: string, create?: string | Buffer): Promise<void> {
  await privateDirectory(dirname(path));
  if (create !== undefined) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(create); } finally { await handle.close(); }
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fault('unsafe_path', 'State files must be regular files without links.');
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    fault('unsafe_permissions', 'State files must belong to the current user and have mode 0600.');
  }
  if (process.platform === 'win32') await windowsPrivate(path);
}

export class State {
  // Tests inject an isolated root. The production CLI always uses defaultRoot().
  constructor(readonly root: string) {}
  path(...parts: string[]): string {
    if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '..' || part === '.')) {
      fault('unsafe_path', 'Invalid state path segment.');
    }
    return join(this.root, ...parts);
  }
  async init(config: Config): Promise<void> {
    this.validate(config);
    await privateDirectory(this.root);
    await privateDirectory(this.path('accounts'));
    await privateDirectory(this.path('artifacts'));
    for (const account of config.accounts) await privateDirectory(this.path('accounts', account.name, 'profile'));
    await privateFile(this.path('config.json'), JSON.stringify(config, null, 2) + '\n');
    await privateFile(this.path('secret'), randomBytes(32).toString('hex') + '\n');
  }
  validate(config: Config): void {
    configSchema.parse(config);
    if (new Set(config.accounts.map(a => a.name)).size !== config.accounts.length) fault('invalid_config', 'Account names must be unique.');
    if (config.browser && !isAbsolute(config.browser)) fault('invalid_config', 'System browser executable must use an absolute path.');
    for (const account of config.accounts) {
      if (account.probeUrl) fileUrl(account.probeUrl);
      for (const origin of account.loginOrigins) {
        if (httpsUrl(origin).origin !== origin) fault('invalid_config', 'Login origins must be exact HTTPS origins.');
      }
    }
  }
  async config(): Promise<Config> {
    await privateFile(this.path('config.json'));
    const config = configSchema.parse(JSON.parse(await readFile(this.path('config.json'), 'utf8')) as unknown);
    this.validate(config);
    return config;
  }
  async secret(): Promise<string> {
    await privateFile(this.path('secret'));
    const token = (await readFile(this.path('secret'), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) fault('invalid_secret', 'Bearer secret is invalid; restore the private secret file.');
    return token;
  }
  async lock(): Promise<() => Promise<void>> {
    await privateDirectory(this.root);
    const id = randomUUID();
    const path = this.path('daemon.lock');
    try { await privateFile(path, JSON.stringify({ pid: process.pid, id })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fault('daemon_locked', 'Another daemon or login owns this profile. A stale lock must be removed manually after confirming its PID is dead.', 409);
      throw error;
    }
    return async () => {
      await privateFile(path);
      const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof owner === 'object' && owner !== null && 'id' in owner && owner.id === id) await rm(path);
    };
  }
}

export class Metadata {
  readonly db: DatabaseSync;
  private constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, session TEXT, account TEXT, file TEXT, target TEXT, generation TEXT, touched INTEGER);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, file TEXT, action TEXT, status TEXT, completed INTEGER);
      DELETE FROM leases;`);
  }
  static async open(state: State): Promise<Metadata> {
    const path = state.path('metadata.sqlite');
    try { await privateFile(path, Buffer.alloc(0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await privateFile(path);
    return new Metadata(path);
  }
  lease(value: { id: string; session: string; account: string; fileKey: string; target: string; generation: string; touched: number }): void {
    this.db.prepare('INSERT OR REPLACE INTO leases VALUES (?,?,?,?,?,?,?)').run(value.id, value.session, value.account, value.fileKey, value.target, value.generation, value.touched);
  }
  removeLease(id: string): void { this.db.prepare('DELETE FROM leases WHERE id=?').run(id); }
  job(id: string, file: string, action: string, status: string): void {
    this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?)').run(id, file, action, status, Date.now());
  }
  prune(): void { this.db.prepare('DELETE FROM jobs WHERE completed<?').run(Date.now() - LIMITS.retentionMs); }
  close(): void { this.db.close(); }
}

export async function pruneArtifacts(state: State): Promise<number> {
  const root = state.path('artifacts');
  await privateDirectory(root);
  const entries: { path: string; size: number; time: number }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^job_[a-f0-9-]+$/.test(entry.name)) fault('unsafe_artifact', 'Unexpected artifact entry.');
    const path = state.path('artifacts', entry.name);
    await checkAncestors(path);
    const info = await stat(path);
    let size = 0;
    for (const file of await readdir(path)) {
      if (!/^(?:before|after|screenshot|export)\.png$|^receipt\.json$/.test(file)) fault('unsafe_artifact', 'Unexpected artifact filename.');
      const filePath = join(path, file);
      await privateFile(filePath);
      size += (await stat(filePath)).size;
    }
    entries.push({ path, size, time: info.mtimeMs });
  }
  entries.sort((a, b) => b.time - a.time);
  let total = 0;
  let kept = 0;
  for (const entry of entries) {
    if (Date.now() - entry.time > LIMITS.retentionMs || total + entry.size > LIMITS.artifactTotalBytes || kept >= LIMITS.artifactJobs) await rm(entry.path, { recursive: true });
    else { total += entry.size; kept++; }
  }
  return total;
}
