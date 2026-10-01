import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productionModule } from './runtime.mjs';
import { auditWindowsAcl } from './windows-acl.mjs';

const { State, privateFile, privateDirectory } = await productionModule('state');

test('NTFS owner-only state: protected ACLs, replacement, links and enforcement failure', { timeout: 90_000 }, async t => {
  assert.equal(process.platform, 'win32', 'Run this native ACL gate only on Windows.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma ACL café space-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new State(root);
  await state.init({ version: 1, accounts: [{ name: 'default', loginOrigins: [] }] });
  const entries = [root, state.path('accounts'), state.path('artifacts'), state.path('accounts', 'default', 'profile')]
    .map(path => ({ path, directory: true, protected: true }));
  entries.push(...['secret', 'config.json'].map(name => ({ path: state.path(name), protected: true })));
  const acl = await auditWindowsAcl(entries);

  const hardlink = state.path('hardlink');
  await link(state.path('secret'), hardlink);
  try { await assert.rejects(state.secret(), error => error.code === 'unsafe_path'); }
  finally { await rm(hardlink); }
  const junction = state.path('junction');
  await symlink(state.path('accounts'), junction, 'junction');
  await assert.rejects(privateDirectory(junction), error => error.code === 'unsafe_path');
  await rm(junction);

  // Replace a cached protected file with a new inode inheriting its root ACL.
  const replacement = state.path('replacement');
  await privateFile(replacement, 'first');
  await rm(replacement);
  await writeFile(replacement, 'replacement');
  await privateFile(replacement);
  await auditWindowsAcl([{ path: replacement, protected: true }]);

  // Force the fixed PowerShell executable to be absent in this test process;
  // no policy/permissions are weakened, and failed enforcement must fail closed.
  const systemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = state.path('missing-system-root');
    await assert.rejects(privateFile(state.path('enforcement-failure'), 'owned fixture'), error => error.code === 'unsafe_permissions');
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
  }
  await privateFile(state.path('enforcement-failure'));
  await auditWindowsAcl([{ path: state.path('enforcement-failure'), protected: true }]);

  let foreignOwner = 'not injected: Set-Acl did not permit SYSTEM owner assignment under this token';
  const foreign = state.path('foreign-owner');
  await writeFile(foreign, 'owned fixture');
  try {
    await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';
        $acl=Get-Acl -LiteralPath $env:QUALIFY_FOREIGN_PATH;
        $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'));
        Set-Acl -LiteralPath $env:QUALIFY_FOREIGN_PATH -AclObject $acl;`],
      { env: { ...process.env, QUALIFY_FOREIGN_PATH: foreign }, windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
    foreignOwner = 'SYSTEM owner injected';
  } catch { /* Capability is reported honestly; ordinary users may not assign SYSTEM ownership. */ }
  if (foreignOwner === 'SYSTEM owner injected') {
    await assert.rejects(privateFile(foreign), error => error.code === 'unsafe_permissions');
    foreignOwner = 'SYSTEM owner rejected';
  }
  if (process.env.QUALIFY_OUTPUT) {
    await writeFile(join(process.env.QUALIFY_OUTPUT, 'windows-acl.json'), JSON.stringify({
      ...acl, hardlinkRejected: true, junctionRejected: true, replacementReprotected: true,
      missingPowerShellFailsClosed: true, subsequentEnforcementRecovered: true, foreignOwner,
      scope: 'Current OS token and owned NTFS fixtures; no account creation, policy changes or same-user/admin isolation claim.',
    }, null, 2) + '\n');
  }
});
