# Operations

## Browser setup

Install the archive as described in the [README](../README.md#install), using
Node.js 22.16.0 or newer and npm. Then initialize and install Chromium:

```sh
figma-server init
figma-server browser-install
```

The Playwright download supplies Chromium, but the host also needs its system
libraries. If Chromium fails to launch, inspect the launch failure before
changing the browser configuration. Installing browser libraries can require
administrator access; do not disable the Chromium sandbox to work around it.

`init` creates local configuration and a secret; it does not install Chromium.
Repeating it preserves existing configuration and credentials. `doctor` checks
state, browser executable presence, display availability on Linux, the profile
lock, and daemon status. Browser launch and sandbox compatibility are checked
by `run`; `doctor` does not launch a browser or sign in to Figma. A stopped
daemon makes `doctor` report a next step and exit with a nonzero status.

To use an installed Chrome/Chromium instead of the bundled browser, stop the
daemon with Ctrl+C before changing browsers. For Linux system Chrome:

```sh
figma-server init --browser /usr/bin/google-chrome
figma-server run
```

Use the absolute executable path on your machine. Normal executable symlinks
are accepted and resolved to the actual executable. `init --browser` updates
existing configuration atomically under the exclusive profile lock, preserving
other settings, the secret, and the browser profile. A running daemon or login
blocks a browser change; stop that owner first. No manual browser-field edit
is needed.

Login opens a visible browser and requires an interactive terminal. Run it
from a graphical desktop session on the same machine. A headless server needs
an operator-provided display; figma-server does not supply browser streaming
or a remote login interface.

## First run and login

Keep `figma-server run` open in terminal 1. In terminal 2:

```sh
figma-server login
figma-server status
```

Enter credentials in the dedicated browser window, complete required prompts,
and press Enter in the login terminal. The service reopens the profile
headlessly to check persistence. A signed-in dashboard can produce
`authenticated_unverified`; opening a real file checks editor access and can
produce `ready`. Neither state alone proves that an edit saved.

Login has a local ten-minute confirmation deadline, whether the daemon is
running or the CLI owns the browser directly. On timeout, the CLI closes the
pending prompt, completes its cleanup attempt, and exits without waiting for
Enter. Run `status` or `doctor`, follow any cleanup warning, then start `login`
again when ready to sign in. A timeout is not a successful login, even if the
browser window opened.

No personal access token or probe URL is needed for the default flow. A
publicly shared file can still require a Figma account. An HTTP error from
Figma, including a CDN block, does not establish that authentication is missing.

If your authentication provider uses another origin, configure the required
`loginOrigins` as described below before retrying. SSO, MFA, and passkey flows
depend on the browser and account; fixture passes do not establish support for
each method. Finish active agent work before logging in again.

## MCP launcher setup

Configure the agent to launch `figma-server` with `args: ["mcp"]`.
`mcp stdio` is an accepted alias. Both use the local secret file; neither
requires an environment variable or a token in the agent configuration. They
connect to the daemon already running at `http://127.0.0.1:4317`.

A desktop agent may not inherit your terminal's PATH. Use the absolute
installed executable path if it cannot find `figma-server`, and make sure
Node.js is also available to that process.

On Windows, a client may need to launch npm's `.cmd` shim through `cmd.exe`.
The local/global shim path passed native fixtures using `cmd.exe /d /s /c`.
Use this launcher template; your desktop MCP client's launch path still needs
its own check:

```json
{
  "mcpServers": {
    "figma-local": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "figma-server", "mcp"]
    }
  }
}
```

The client still needs `figma-server` on its PATH. As an alternative, use an
absolute path to `node.exe` as `command`, with the installed JavaScript entry
point and `mcp` as separate arguments. Run `npm root --global` to find the global
package directory, then append `@ctxrs/figma-server/dist/src/cli.js`. Paths with
spaces belong in individual JSON arguments; do not add shell quotes inside
them. The [qualification guide](TESTING.md) separates native package tests
from desktop client launch, human sign-in, and live editing.

## State and configuration

The production state location is fixed by the operating system:

| Platform | State directory |
| --- | --- |
| Linux | `~/.figma-server` |
| macOS | `~/Library/Application Support/figma-server` |
| Windows | `%USERPROFILE%\AppData\Local\figma-server` |

These paths come from the implementation; they are not evidence of completed
platform testing. Each is resolved from the current user's home directory.
There is no production data-directory environment override.

```text
<state-directory>/
  config.json
  secret
  accounts/default/profile/
  metadata.sqlite
  artifacts/<job-id>/
  daemon.lock
```

The browser profile holds the Figma web session. `secret` holds the separate
local bearer token. Do not copy either into source control, MCP JSON, or an
issue report. SQLite stores lease/job metadata, not the browser profile.

The profile keeps the signed-in Figma session across browser and daemon
restarts, until Figma expires it or requests sign-in again. MCP and HTTP client
sessions and file leases have their own lifetimes; closing a client does not
erase that login. The CLI manages setup, login, status, server startup and the
MCP proxy. Agents with shell access call tools through the JSON HTTP API.

Configuration is JSON. The minimal shape is:

```json
{
  "version": 1,
  "accounts": [
    {
      "name": "default",
      "loginOrigins": []
    }
  ]
}
```

No probe file is required for login. Without one, the supervisor checks the
signed-in dashboard and reports `authenticated_unverified`: authentication was
observed, but editor access has not been established. Opening a file checks
that file's editor and can move the account to `ready`.

For an earlier editor check, add optional `probeUrl` to the account with a real
file URL it can access, or set it on first initialization with
`figma-server init --probe-url URL`. If state already exists, edit `config.json`
while the daemon is stopped; repeating `init` does not replace its probe URL.
Reaching a sign-in page is not enough.

A system browser is recorded in the optional top-level `browser` field.
Use `init --browser` to set it and resolve executable symlinks. Otherwise
the service uses Playwright's Chromium. It always uses its dedicated profile;
there is no command to attach your daily Chrome profile.

## Google and enterprise SSO

Headed login permits Figma and the account's configured `loginOrigins` only.
The default list is empty, so navigation to Google or an enterprise identity
provider is blocked until you configure its exact origin.

Stop the daemon with Ctrl+C and edit `config.json` in the
[state directory](#state-and-configuration). Update the chosen account's
`loginOrigins` field inside `accounts`, preserving its other settings. For
users who choose Google sign-in, the account fragment is:

```json
{"loginOrigins": ["https://accounts.google.com"]}
```

For enterprise SSO, enter the exact HTTPS origin of your organization's sign-in
provider: the scheme and hostname, without a path or wildcard. For example, if
your provider's sign-in URL is `https://sso.your-company.example/login`, use
`https://sso.your-company.example`; replace this illustrative hostname with the
actual provider origin. Add only origins needed by your chosen sign-in flow.

Restart `figma-server run`, then run `figma-server login` in the other terminal.
These extra origins apply only to the headed human login, not agent navigation
or headless file access. Configuration does not establish that a provider flow
has been tested; Google and enterprise SSO compatibility remains unverified.

## Profile ownership and recovery

`figma-server login` also works before daemon startup: the CLI takes the
profile lock, runs headed login, checks persistence headlessly, then closes
the browser and releases the lock. Login requires an interactive terminal and
a graphical display. Enter credentials in the browser and press Enter in the
terminal once sign-in is complete.

With a running daemon, login is coordinated through the HTTP adapter. It closes
the account's leased tabs, stops its headless browser, opens a headed browser,
waits for confirmation, probes the dashboard or optional file, then reopens the
profile headlessly to check persistence. Finish agent work before logging in
again; active account leases are invalidated. Once the daemon returns a login
handle, interrupting the login terminal sends a cancellation request and waits
for cleanup. If interrupted while the window is still opening, or if cleanup
cannot be confirmed, stop the daemon with Ctrl+C before retrying login.

The state layer supplies an exclusive `daemon.lock` in the state directory
to prevent independent processes opening the same profile. A remaining lock is
not removed automatically. Before removing one, check that the recorded PID and
any browser using this dedicated profile have exited. Removing a live owner's
lock can permit two processes to open the profile.

On Unix, state directories are set to mode 0700 and state files require 0600.
The implementation rejects linked state paths and some alternate path layouts.
On Windows, private state paths receive protected NTFS ACLs granting the
current account access. The native fixture pass used an elevated lab token;
ordinary-user setup remains unverified. These checks do not isolate clients
running as the same OS user or protect against trusted administrators. See the
[recorded qualification scope](TESTING.md#recorded-native-qualification-2026-10-01).

Keep the daemon in the foreground for the first run. After a crash, inspect
status and existing processes before restarting. A persisted browser profile
can retain login, but leases are cleared when the metadata database opens.
Reopen the file and inspect any uncertain edit rather than assuming it rolled
back.

## Artifacts

Artifacts are stored below the server's state directory. Current configured
limits make jobs eligible for pruning after one hour, with 8 MiB per artifact
and 128 MiB total. Pruning can remove older jobs when the total budget is exceeded.
Consume or copy evidence promptly; these directories are not a permanent
archive. Screenshot pixels can contain design text even when text output is
redacted.

## Network access

Keep the local daemon on loopback and use the MCP proxy for the first run.
The HTTP boundary checks the Host and Origin headers and requires the local
bearer token. The proxy supplies that credential without putting it in agent
configuration. Use this service with your own trusted agents: JavaScript and
full CDP have the authority of its dedicated browser. Raw results are
unredacted and size bounded. These tools are included in v0.2.0; see
[agent tools](agent-tools.md#javascript-cdp-and-events) for arguments and examples.

Tab-scope CDP starts from the managed leased tab. Raw JavaScript/CDP can navigate
that tab to another file or use cross-target/shared-state commands, bypassing
managed file coordination. Browser scope can control all targets in the shared
account's browser. Many agents may use it concurrently. `figma.cdp_close` detaches a lease/scope
connection; it does not stop the shared browser or release the file lease.
Raw-created targets are outside the eight managed-tab slots and remain their
caller's responsibility until closed or the browser stops.

Attaching raw CDP puts the shared account worker into trusted raw control for
that browser generation, allowing navigation, popups and downloads throughout
the shared worker. This transition persists until a browser restart; closing
CDP connections or releasing leases does not restore the restrictions. Stop
and restart the daemon when you need a fresh worker. Its dedicated profile
still retains the Figma login.

Concurrent tabs also share a clipboard; see
[clipboard limits and supported alternatives](agent-tools.md#clipboard-and-concurrent-tabs).

Figma's web app still contacts Figma, and the connected agent receives tool
output and screenshot pixels. Local browser state does not imply that design
content stays off the agent's model provider. Check that client's data handling
before using confidential files.

For access from another machine, an operator-configured SSH tunnel keeps the
server-side listener local. A tunnel does not provide the graphical display
needed for login. Direct HTTP workers still need the bearer token; never expose
a raw Chromium debugging endpoint.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Chromium executable is missing | Run `figma-server browser-install`, or stop the daemon and select an installed browser with `init --browser`. |
| Browser fails before displaying Figma | Check system libraries, the display for headed login, and the configured executable. |
| Chromium reports no usable sandbox | Keep the sandbox enabled. Stop the daemon, then try `figma-server init --browser /usr/bin/google-chrome` if system Chrome is installed on Linux. Check host policy and dependencies. |
| The install URL returns 404 | Check the release tag and archive filename in the URL. Install a downloaded release archive if needed. |
| Global npm install fails on permissions | Use a Node/npm installation or global prefix writable by your OS account. Run setup, the daemon, and the MCP client as the same account. |
| The agent cannot find the MCP command | Check its PATH or use an absolute launcher path; see [MCP launcher setup](#mcp-launcher-setup). |
| `status` reports a stopped daemon | Keep `figma-server run` open in another terminal. The MCP proxy does not start it. |
| A profile is already in use | Check the running daemon/login process and `daemon.lock`; do not remove a live lock. |
| Figma sign-in succeeds but the file is inaccessible | Check the file URL, account, sharing permissions, and SSO flow. |
| Login times out or its browser closes before confirmation | Check `status`/`doctor`, follow the CLI cleanup message, and start `login` again. Do not count the timed-out attempt as authenticated. |
| An artifact is missing | It may have been pruned by age or storage budget. |
| An edit is unverified or a request disconnects | Inspect the file and available evidence before repeating the edit. |
