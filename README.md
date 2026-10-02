# figma-server

Run a dedicated Figma browser for your agents.

`figma-server` connects MCP clients and JSON HTTP tooling to the Figma web editor
through local Chromium. Sign in once in its dedicated browser profile and reuse
that session across agents until Figma asks you to sign in again.

An agent can inspect the visible editor, take screenshots, and send clicks,
text, keyboard shortcuts, and drags. It can hold modifiers for a gesture and
supply PNG/JPEG bytes to an editor file chooser.

Connect through MCP stdio, or call the JSON HTTP API from your own tooling.
Keep the same browser setup when you switch agent clients or model providers.
There is no model-provider allowlist. The service runs independently of Figma's
official MCP server.

The browser profile and local service credential stay on your machine. Figma
still uses its cloud service, and tool results and screenshots go to your agent
client and any model provider it uses. Choose the agent accordingly.

## Install

You need **Node.js 22.16.0 or newer**, npm, and a graphical desktop for sign-in.

v0.1.0 is a prerelease. See the [tested configurations](docs/TESTING.md) for
native workflow coverage.

```sh
npm install --global https://github.com/ctxrs/figma-server/releases/download/v0.1.0/ctxrs-figma-server-0.1.0.tgz
```

## Log in and connect your agent

In terminal 1:

```sh
figma-server init
figma-server browser-install
figma-server run
```

Keep `run` open. It owns the browser profile and listens on
`http://127.0.0.1:4317`. Stop it with Ctrl+C when finished.

Before Google or enterprise SSO login,
[configure the exact provider origins](docs/operations.md#google-and-enterprise-sso)
and restart the daemon.

In terminal 2:

```sh
figma-server login
figma-server status
```

`browser-install` installs full Chromium. `login` opens it in a dedicated
profile: sign in to Figma there, complete any prompts, then press Enter in
terminal 2. A Figma API key cannot authenticate this web editor; no personal
access token is needed. The profile reuses your session between runs until
Figma requires sign-in again. The service checks it by reopening headlessly.

You do not need to configure a probe file first. `authenticated_unverified`
means a signed-in dashboard was observed; ask the agent to open a file to check
editor access. The account can then report `ready`. If setup fails, run
`figma-server doctor`; see [browser and login recovery](docs/operations.md).

Add this server to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "figma-local": {
      "command": "figma-server",
      "args": ["mcp"]
    }
  }
}
```

The agent launches `figma-server mcp`. This stdio proxy reads the local secret
file and connects to the running daemon. No environment variables or pasted
tokens are needed. `figma-server mcp stdio` is also accepted.

If the agent cannot find the command, give it the installed executable's
absolute path. See [MCP launcher setup](docs/operations.md#mcp-launcher-setup)
for PATH and Windows launcher details. The proxy does not start the daemon.

Connect multiple agents to the same daemon. Each file lease has its own tab,
so agents can work on different files in parallel. For the same file, one
agent from this server holds the writer lease at a time. Another writer waits
up to 30 seconds, then receives `file_busy` if the lease is still held. Human
collaborators and other clients remain outside that lock. MCP stdio and the
JSON HTTP API share these rules. See
[agent tools](docs/agent-tools.md) for exact inputs and lease handling.

## Try it

Give your agent a Design file URL your signed-in account can access. Use a plain
file URL for dashboard opening; if a selection link is unsupported, remove
`node-id` and `page-id` before trying again.

> Open this Figma file in read mode, inspect the visible layers and controls,
> take a screenshot, and release the file. Tell me if editor access could not
> be verified.

For a first edit, use a disposable Design file with edit access:

> Create a Frame in this test file. Set Width to 600 and Height to 400,
> pressing Enter after each field, then read both values back. Take a
> screenshot, release the file and open the same URL again. Reselect the Frame
> and read both fields again. Report any observed save state separately;
> leave it unknown if no indicator is identifiable. Release the file when done.
> If a step cannot be verified, stop and show me what you observed.

See [agent tools](docs/agent-tools.md#a-small-edit-with-readback) for field
readback and text inputs, and the [image example](docs/agent-tools.md#supplying-an-image)
for chooser uploads. Native text content and image insertion/save have separate
qualification limits.

## Know the limits

- Design property edits were verified on Linux after normal reopening and a
  browser restart; macOS verified reading those properties and reopening.
  macOS editing, ordinary-user Windows setup, other editor types, native text
  content, image insertion and component/style workflows remain unqualified.
  See the [tested configurations and evidence](docs/TESTING.md).
- The tools operate the visible web editor. Inspection and field readback are
  bounded; there is no complete native Figma node API. The CDP tool exposes
  viewport metrics only.
- A dispatched input can remain `unverified`. A failed or lost response can
  still leave a change in the file; inspect before repeating it.
- Tabs share a clipboard. Clipboard shortcuts are blocked; menu or coordinate
  copy/paste is unsupported during concurrent work. Use explicit text inputs;
  see [clipboard limits](docs/agent-tools.md#clipboard-and-concurrent-tabs).
- PNG export captures the rendered viewport or an accessible element. Native
  node exports and faithful HTML-to-layer conversion are not implemented.
- Figma UI changes can break selectors and readiness checks. Accepted Design,
  FigJam, Slides, or prototype URLs do not establish that each editor works.

Keep your normal browser profile separate. Finish agent work before signing in
again: login invalidates that account's active leases. See
[Operations](docs/operations.md) for browser setup, state, and recovery.

## Development

From a source checkout:

```sh
npm ci
npm run build
node dist/src/cli.js init
node dist/src/cli.js browser-install
node dist/src/cli.js run
```

Use `node dist/src/cli.js` in place of `figma-server` for the remaining commands.
For an agent client, use `command: "node"` with the absolute path to
`dist/src/cli.js` followed by `mcp` in `args`.

```sh
npm test
npm run format:check
```

`format:check` runs the TypeScript compiler without emitting files. Browser
fixtures and source tests do not establish live Figma editing; the
[qualification guide](docs/TESTING.md) describes the separate checks.

| Documentation | What it covers |
| --- | --- |
| [Operations](docs/operations.md) | Browser setup, login, MCP launchers, local state, and recovery. |
| [Agent tools](docs/agent-tools.md) | MCP and HTTP API, tool inputs, leases, and verification. |
| [Release qualification](docs/TESTING.md) | Package, browser, platform, and live-Figma evidence. |
