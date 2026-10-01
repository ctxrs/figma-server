import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

export async function auditWindowsAcl(entries) {
  if (process.platform !== 'win32') return null;
  const script = `$ErrorActionPreference='Stop';
    $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
    $sid=$identity.User.Value;
    $principal=[System.Security.Principal.WindowsPrincipal]::new($identity);
    $checked=0;
    foreach($entry in ($env:QUALIFY_ACL_ENTRIES | ConvertFrom-Json)) {
      $acl=Get-Acl -LiteralPath $entry.path;
      if($entry.protected -and !$acl.AreAccessRulesProtected){throw 'State ACL inherits permissions'};
      if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unexpected state owner'};
      $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));
      if($rules.Count -ne 1){throw 'Unexpected state ACE count'};
      $rule=$rules[0];
      if($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or
         $rule.FileSystemRights -ne 'FullControl' -or [int]$rule.PropagationFlags -ne 0){throw 'Unexpected state ACE'};
      $inheritance=if($entry.directory){3}else{0};
      if([int]$rule.InheritanceFlags -ne $inheritance){throw 'Unexpected ACE inheritance flags'};
      $checked++;
    };
    @{ checked=$checked; ownerCurrentSid=$true; onlyCurrentSidFullControl=$true;
       effectiveAdministrator=$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress;`;
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, QUALIFY_ACL_ENTRIES: JSON.stringify(entries) }, windowsHide: true, timeout: 20_000, maxBuffer: 4096,
    });
  return JSON.parse(stdout.trim());
}
