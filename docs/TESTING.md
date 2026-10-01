# Release qualification

Run from a checkout with Node 22.16+ or Node 24 and npm. This suite needs no
Figma login: an intercepted, local editor fixture exercises the production
browser supervisor and adapters. A fixture pass does **not** prove Figma UI
compatibility, SSO/MFA/passkeys, real autosave, or native node export fidelity.

```sh
npm ci
npm exec -- playwright install --no-shell chromium
node scripts/qualify.mjs --output /absolute/path/to/evidence
```

On Linux CI, use `playwright install --with-deps --no-shell chromium` to
install shared libraries too. The full browser is required for headed login;
a headless-shell-only install is insufficient. Chromium's sandbox remains on.
On a governed shared host, wrap installs and qualification:

```sh
ctx-build-governor exec -- npm exec -- playwright install --no-shell chromium
ctx-build-governor exec -- node scripts/qualify.mjs --output /tmp/figma-evidence
```

The runner builds and runs the package tests, typechecks, packs the package,
installs that tarball with production dependencies into a temporary directory
containing spaces, tests the installed CLI, and runs the
installed browser supervisor against real Chromium. It removes the temporary
consumer and browser profiles. Evidence contains OS/Node/browser versions,
tarball SHA-256, step outcomes, and fixture screenshots; no profiles or tokens.
Any failed step exits nonzero. Missing browsers/source/tests are failures, not
skipped passes. Archive-only runs exercise the installed platform/API fixtures;
source unit tests remain a separate source-CI gate and need not ship in npm.

The launcher fixture executes npm's actual local shim and also performs a
`npm install --global --prefix TASK_OWNED_DIRECTORY ARCHIVE` installation. It
executes that global shim from a path containing spaces, checks help/init,
negotiates MCP stdio through the installed proxy, opens an inert fixture lease,
and closes stdin. Success requires natural exit 0, valid protocol-only stdout,
and zero remaining daemon sessions/leases. An SDK forced-kill fallback cannot
count as EOF success. The operator's global prefix/configuration is untouched.
On Windows it invokes `.cmd` explicitly through `cmd.exe /d /s /c`, never a
PowerShell npm shim or an ExecutionPolicy change. These checks qualify launcher
and transport wiring; real Chromium has separate tests.

For a focused launcher-only replay without browser installation:

```sh
ctx-build-governor exec -- node scripts/qualify.mjs \
  --archive /absolute/path/candidate.tgz --suite launcher --output /tmp/launcher-evidence
```

The stdio proxy uses the product's fixed loopback port 4317. If another daemon
owns that port, this probe fails as blocked; do not stop it or reuse its token.
Windows package qualification also independently reads the initialized NTFS
DACLs: state root, secret, config and browser profile must have protected ACLs
with only the current SID receiving FullControl. Success is not a Windows
credential-vault or administrator-isolation claim.
The Windows-only ACL fixture also checks directory/file inheritance flags,
hard-link and junction rejection, replacement-file protection, and fail-closed
behavior when the fixed PowerShell executable is unavailable. Browser-created
profile descendants and actual API SQLite/PNG/receipt files have independent
ACL audits. The evidence reports whether the token is effectively an
administrator; an admin-token pass does not establish ordinary-user setup.
SYSTEM-owner injection is attempted only on an owned test file and is reported
as unavailable if the token cannot assign that owner. No account or machine
policy changes are part of qualification.

To test a built archive without rebuilding it:

```sh
node scripts/qualify.mjs --archive /absolute/path/candidate.tgz --output /tmp/archive-evidence
```

To test system-browser mode, add `--system-browser /absolute/path/to/chrome`.
Bundled mode remains the required baseline. Both modes verify actual browser
arguments, separate tabs/screenshots, typed postconditions, denied navigation,
same-machine fixture storage persistence, real browser crash, and recovery.
These tests inject a fresh State root. CLI subprocesses receive a temporary
home/profile environment; they never initialize the operator's Figma profile.
That CLI isolation is not proof of Windows account/vault behavior.

An explicit headed fixture can run on Linux with Xvfb. It checks the actual
login bootstrap, exclusive profile ownership and subsequent headless reopen,
using intercepted pages rather than authentication. It is separate from the
headless OS matrix and does not prove a human can complete Figma sign-in:

```sh
ctx-build-governor exec -- env QUALIFY_HEADED=1 xvfb-run -a \
  node scripts/qualify.mjs --archive /absolute/path/candidate.tgz \
  --system-browser /usr/bin/google-chrome --output /tmp/figma-headed-evidence
```

On Ubuntu hosts with AppArmor restrictions, a downloaded Chromium may report
"No usable sandbox" while an installed system Chrome works. Keep the sandbox
enabled and qualify that explicitly configured system mode. For fresh product
state use `figma-server init --browser /absolute/path/to/chrome`; existing state
is preserved, so follow the CLI's configuration instructions rather than
overwriting it. This host restriction is not evidence that all Linux installs
fail. `doctor` checks setup and reports the stopped daemon; the browser tests
prove actual launch and sandbox behavior separately.

## CI and remaining release gates

| Layer | Concrete qualification gate | Evidence boundary |
| --- | --- | --- |
| Unit | `npm test` and `npm run format:check` pass: URL/schema rejection, state ancestry/permissions, leases, cancellation/timeouts, receipts and artifact ownership. | Fakes establish invariants; they do not establish browser or Figma behavior. |
| Integration | Production MCP and JSON HTTP reject missing/wrong bearer credentials, hostile Host/Origin, cross-session leases and arbitrary Runtime CDP. Same-file writes serialize across adapters; different-file operations overlap. | Local intercepted editor in a real browser; one trusted local operator, not a multitenant security guarantee. |
| Package/e2e | Install the npm archive with production dependencies only outside the checkout, including spaces in paths. CLI init/doctor and exclusive profile locking pass. Real full Chromium passes isolated tabs/PNGs, navigation denial, profile persistence, OS process termination and recovery on native OS/Node rows. | Record OS architecture, browser mode/version and archive SHA. An authored or skipped CI row is not a pass. |
| Headed fixture | Explicit graphical bootstrap survives opening the login page, excludes concurrent account access, closes and reopens the same profile headlessly. | Xvfb is startup/lifecycle evidence, not human sign-in or desktop integration evidence. |
| Live/manual | On at least one OS, sign in with an authorized disposable account, reopen headlessly, edit a known disposable Figma design, observe save, close and reopen to verify persistence. | Record the exact auth method/file type. Keep SSO/MFA/passkeys, other Figma file types, Windows 11 interaction and untested architectures explicitly unproven. |

Browser discovery has separate gates: bundled mode uses the matching installed
Playwright full Chromium; explicit system mode accepts an absolute executable
path (including a legitimate executable symlink) and records the actual browser
version. Missing browser binaries must fail with installation/configuration
guidance. Existing config/secret files must survive repeated init. Test system
mode on a representative native host; it does not replace missing bundled-mode
evidence. Do not qualify an implicitly chosen personal browser profile.

`.github/workflows/qualification.yml` runs Ubuntu 24.04, macOS 14, and Windows
Server 2022 on Node 22 and 24. It uses the lockfile, installs full Chromium,
and qualifies the actual npm archive. Actions are pinned; only credential-free
evidence is uploaded. A configured matrix is not native execution evidence.

Before release, require passing native archive/browser fixtures for each
claimed OS and Node version, plus real authenticated headed login → headless
reopen → persisted disposable Figma edit/save on at least one OS. Record that
OS, browser, file type and auth method; the fixture matrix does not establish
live editing on the other platforms. Verify invalid/missing
bearer tokens, Host/Origin checks, lease ownership, narrow CDP policy, same-file
write serialization and different-file concurrency across MCP/JSON clients.
Use a disposable account and known file; do not upload live screenshots,
cookies, profile databases, or raw traces. Windows Server headless CI does not
prove Windows 11 interactive login; Intel execution does not prove Apple silicon.

## Recorded native qualification: 2026-10-01

The development candidate archive had SHA-256
`83e1450b7e60d6fd5f5600763d48ae6ea6b2cad7cbfdf0ac2a130da757907151`.
These results apply to that archive, not to subsequent source changes or a
future release archive. Playwright was 1.63.0 and MCP SDK was 1.31.0.
The earlier Windows baseline checked CLI entry execution and shim presence,
not actual `.cmd` invocation or the later NTFS ACL implementation. Those changes
are qualified separately below; they are not covered by baseline reuse.

| Native environment | Node | Actual browser mode | Result and scope |
| --- | --- | --- | --- |
| Ubuntu 24.04.4, x64 | 22.22.2 and 24.21.0 | System Chrome 150.0.7871.124 | Passed installed CLI/state, real browser, MCP/HTTP auth and concurrency, process crash/recovery, and explicit Xvfb headed-bootstrap/headless-reopen fixtures. |
| Windows x64 lab guest; OS build absent from captured summary | 22.23.3 and 24.21.0 | Bundled Chromium 153.0.8010.12 | Passed installed CLI/state, real browser, MCP/HTTP auth and concurrency, profile persistence and process crash/recovery. Replay exit 0; both summaries present and untruncated. No headed Windows test. |
| macOS 26.2 (25C56), ARM64; separately executed macOS lane | 22.22.2 | System Chrome 154.0.8037.92 | Five tests passed in 18.63s: installed bin help, explicit-State CLI lifecycle, real browser, auth/shared locks and cleanup. Standalone default-home init/run excluded from that lane's scope. |

Ubuntu bundled Chromium failed with Playwright's "No usable sandbox" diagnostic;
the sandbox stayed enabled. The explicit system-browser pass is retained as
separate evidence. No bundled macOS or macOS Node 24 pass was recorded. The
hosted six-row Actions workflow was linted but could not execute because of
the account billing lock. These gaps must remain visible in support claims.

All successful editor interactions above used controlled local fixtures.
The macOS live login page rendered with HTTP 200; the Community probe returned
403. Neither establishes authenticated editing. Real authenticated edit/save
qualification on at least one OS remains required before release; other auth
methods, file types and native interactive flows retain their stated limits.

A subsequent candidate, SHA-256
`f75f61ecfa1a25a6d37c0cd5e1eae04a5a5e71c1d85cf3e09e238cdbeb16a73b`,
passed full installed-archive qualification on Ubuntu/Node 22.22.2 with system
Chrome, including actual local/global npm shim invocation, MCP initialization
and natural EOF session/lease cleanup. macOS and Linux Node 24 entries above
remain evidence for the earlier digest rather than silently becoming passes
for the new archive.

The same f75 archive passed all six installed-archive qualification steps on
Windows x64, OS release `10.0.26200`, Node 22.23.3 and 24.21.0, with bundled
Chromium 153.0.8010.12. Replay `req-1ca458e7582c43d5` exited 0 with untruncated
output and both explicit Node pass summaries. Actual local/global npm `.cmd`
shims ran through `cmd.exe /d /s /c`: help/init, MCP handshake, natural EOF exit
0 and zero remaining sessions/leases all passed. Protected state, SQLite,
receipt and PNG ACL audits, SYSTEM-owner rejection, hard-link/junction rejection,
replacement protection and missing-PowerShell fail-closed checks passed,
alongside real browser crash/recovery and MCP/HTTP auth/concurrency fixtures.

This is **elevated Windows lab-token coverage**. Protected paths had current-SID
ownership and only current-SID FullControl. Three Chromium-created descendants
had Administrators ownership and exactly one inherited current-SID FullControl
ACE, consistent with the trusted-administrator boundary. Ordinary non-admin
setup, Windows desktop MCP clients and interactive sign-in remain unproven.
No account, privilege or machine-policy changes were made.

Two earlier attempts timed out before disk admission. Native receipt
`req-42f6926c33ff4ec0` then failed an overly strict browser-descendant owner
assertion; this was resolved by a reviewed harness correction, not a production
fix. Both failed and passing receipts are retained outside the checkout; the
passing summary is `windows-qualification.json`. These results qualify f75's
Windows ACL/launcher behavior, not a later archive or live Figma editing.

## Focused upload/modifier qualification: 2026-10-01

The coherent candidate is SHA-256
`1c0e8505fccbb3b51272c7461ecf3c1086301676ab8356243aeebafeed29d910`,
89,979 bytes and 45 package files. Source qualification independently passed
101/101 tests without skips. Its archive and 28 source/compiled-code/manifest
hashes are retained in the private qualification manifest `candidate.json`;
compiled JavaScript in the archive matched the frozen build. The focused runner
requires `--archive`, installs production dependencies and does not rebuild,
repack, or repeat the baseline CLI/crash/auth matrix.

| Native environment | Node | Actual browser | Focused result |
| --- | --- | --- | --- |
| Ubuntu 24.04.4, x64 | 22.22.2 and 24.21.0 | System Chrome 150.0.7871.124, sandbox enabled | Each runtime passed three qualification steps and two tests, zero failures/skips. `ControlOrMeta` resolved to Control. |
| macOS 26.2 (25C56), ARM64 | 22.22.2 | System Chrome 154.0.8037.92, sandbox enabled | Three qualification steps and two tests passed, zero failures/skips. `ControlOrMeta` resolved to Meta. |
| Windows x64 | Planned 22.23.3 and 24.21.0 | Planned full bundled Chromium | Blocked before execution: replay `req-5161cadfa4c54fc9` timed out after five minutes awaiting disk admission. No new Windows feature tests ran. |

Passing receipts are `linux-node22-receipt.json`, `linux-node24-receipt.json`
and `macos-receipt.json`, retained outside the checkout.
The macOS raw log and cleanup receipt are retained in `macos/`: native exit 0,
no remaining task browser processes. Its temporary remote root was removed
only after verifying all eight retained success/failure proof-file hashes.
Earlier baseline digests do not qualify these new features.

The Windows sealed receipt is exit 70 with zero guest-output bytes; the outer
replay command exited 75. This is an admission failure, not a product test
failure or a skipped pass. Its receipt is retained in `windows-admission-receipt.json`
and the governed log in `windows-replay-runner.log`. After reviewed cleanup of
two completed task-owned overlays, the 20:56:12 UTC snapshot still had
106,616,532,992 free bytes against the unchanged 107,374,182,400-byte minimum.
Original sealed bundles and success/failure receipts remain retained separately.
New Windows upload/modifier/stdio/deadline qualification remains pending;
the earlier f75 elevated-token ACL/launcher pass retains its narrower scope.

The focused suite runs two tests:

- Real headless Chromium through installed Core, HTTP and the actual local npm
  stdio shim: PNG/JPEG hashes and tab isolation, unsafe filenames rejected before
  screenshots/chooser effects, held click/drag modifiers, release after an
  interrupted drag, and `ControlOrMeta` resolving to Meta on macOS or Control on
  Windows/Linux. A genuine PNG frame larger than 128 KiB must upload successfully;
  an oversized ordinary frame must be rejected without effects. After the client
  closes stdin, successful EOF exit 0 and rejected-frame exit 1 must be natural,
  with owned sessions/leases cleaned. Error exit with stdin still open is not
  claimed; the independent login-deadline test retains that stricter gate.
- Installed `runCli` in independent child processes: short local and backend
  login deadlines, real readline and stdin left open without Enter/EOF, natural
  exit, input-listener removal, and lock/daemon cleanup. Only the TTY gate and
  deadlines are injected; the login backend is inert. This is not GUI sign-in.

All passing rows accepted a real 301,493-byte PNG MCP frame and checked PNG/JPEG
file hashes, tab isolation and cleanup. This is not an 8 MiB native-upload claim.
The deadline test has two child modes, offline and daemon; those are assertions
within one test, not two additional tests. Both exited naturally with stdin
open and no remaining readline data listeners. An initial Linux attempt wrongly
required ordinary-frame rejection to exit with stdin open; the corrected harness
closes stdin after rejection, preserving the stricter open-stdin login gate.
An initial macOS attempt rejected its staging directory's copied mode 0775;
only that owned directory was corrected to 0700 before the passing run.
Both failed reports remain retained; neither correction changed product code.

Windows additionally audits current-SID ownership and protected DACLs on state,
profile, SQLite, upload receipts and PNGs, recording the actual token type. Use
full bundled Chromium with its sandbox enabled. Expected lab coverage remains
the elevated token; ordinary non-admin setup is unproven. macOS must record
`arch: arm64` and actual system Chrome; its mouse events must show Meta rather
than Control. Linux uses a real headless browser; no graphical login is needed
for the independent deadline fixture. Fixed port 4317 must be free.

A bounded standard-token Windows probe was assessed but not executed because
no guest was admitted. The existing loaded-profile launcher targets its current
provisioned account; it does not directly launch a new standard account. Any
optional follow-up needs an isolated guest-only launcher, `IsAdmin=false`,
current-SID private ACLs, one native Chromium upload and the independent CLI
deadline. Ordinary-user support remains unproven; this is not an additional
broad release matrix or permission to change machine policy/operator profiles.

After source/archive admission, run Linux and macOS separately:

```sh
# Linux: working sandboxed system Chrome on the governed host.
ctx-build-governor exec -- node scripts/qualify.mjs \
  --archive /absolute/path/coherent-candidate.tgz --suite primitives \
  --system-browser /usr/bin/google-chrome --output /tmp/figma-primitives-linux

# Native macOS ARM64 owner: verify uname -m is arm64 before running.
node scripts/qualify.mjs --archive /absolute/path/coherent-candidate.tgz \
  --suite primitives \
  --system-browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --output /tmp/figma-primitives-macos
```

The Windows builder accepts `--suite primitives` and the replay entry uses that
selection for both verified Node runtimes. The current sealed bundle is
`windows-qualification.tar`, retained outside the checkout,
SHA-256 `3e1de63550a3e9049a9368152d65d74ba5109b09d87ea8eeef9b4fbac48354f6`.
Do not invoke qualification before source admission:

```sh
ctx-build-governor exec -- node scripts/qualify-windows-bundle.mjs \
  /absolute/path/coherent-candidate.tgz /tmp/figma-primitives-windows --suite primitives
```

Use the governed request/replay/feedback commands below with its sealed digest.
Require exit 0, untruncated output and explicit Node pass summaries containing
`primitives` and `loginDeadline`. Linux/macOS evidence is `qualification.json`,
`primitives.json` and `login-deadline.json`; retain archive SHA and actual OS,
architecture, Node, browser and token scope. No native evidence is created by
syntax checks. These fixtures do not prove authenticated Figma image placement,
held-modifier UI compatibility, or persisted native edits; human login remains
required for that separate gate.

## Governed Windows replay

Use the installed `ctx-lab replay --help` schema and the package-owned lab
runbook in the manager's environment. The local operator references are:

- `ctx-private/internal-tools/ctx-lab/README.md`: request/run/replay, exclusive
  payload staging, bounded timeouts, feedback, and sharing policy.
- `ctx-private/internal-tools/ctx-build-governor/README.md`: local heavy and
  remote-control lanes.

Create the replay bundle outside the checkout with the supplied builder:

```sh
ctx-build-governor exec -- node scripts/qualify-windows-bundle.mjs \
  /absolute/path/candidate.tgz /tmp/figma-windows-qualification
```

The builder verifies official Node 22/24 ZIP checksums and writes
`windows-bundle.json` with candidate/runtime/bundle digests. It creates a
sealed tar containing exactly one `run-replay.ps1`, copied
from `tests/platform/run-replay.ps1`, `scripts/qualify.mjs`, the platform MJS files,
the root package manifest, the built npm tarball, and two official portable
Windows Node ZIPs. `candidate.json` names the tarball and its SHA-256;
`windows-runtimes.json` is an array of objects with `major`, `filename`,
`directory`, and `sha256`. Verify the ZIP hashes against nodejs.org's published
SHASUMS before sealing. The entry independently checks all three archives,
installs Chromium in a task-owned cache, and qualifies the same npm tarball
under both Node versions. It emits a compact summary and cleans its runtime,
consumer and browser cache; ctx-lab owns whole-guest teardown.

```sh
ctx-lab status
ctx-lab request windows-x64 --profile light \
  --sharing exclusive --purpose "figma-server Node 22/24 archive and browser qualification" \
  --eta 15m --blocking
ctx-build-governor remote -- ctx-lab replay REQUEST_ID /absolute/path/bundle.tar \
  --bundle-sha256 SHA256 --wait-timeout 5m --command-timeout 15m
ctx-lab feedback REQUEST_ID --experience smooth --useful-result yes \
  --category none --comment "Node 22/24 outcomes recorded; no live Figma credentials."
```

Report actual outcomes in feedback, including failed/blocked runs. Admission
and replay results are distinct. Read the lab-owned
`STATE_DIRECTORY/replay-receipts/REQUEST_ID.json`: require exit code zero,
untruncated output and both explicit Node pass summaries. The receipt survives
guest cleanup; copy it into the evidence directory outside the checkout.
On this operator installation, `STATE_DIRECTORY` is `/var/lib/ctx-lab`; consult
the installed configuration rather than assuming this path elsewhere. Admission
failure or unavailable billing is infrastructure evidence, not a product-test
pass. Do not relax thresholds, bypass the governor, or delete another task's
proofs. Physical macOS SSH qualification also belongs in the governor's `remote`
lane: its command accepts the bounded SSH runner without consuming a local
heavy slot. Local Linux browser execution and local bundle construction use
the heavy `exec` lane. Keep private staging ancestry owner-only: copying a
directory's group-writable mode can correctly trigger `untrusted_ancestry`.
