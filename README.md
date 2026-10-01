# figma-server

Give your agent a dedicated Figma browser.

`figma-server` connects an MCP agent to the Figma web editor through a local
Chromium session. The agent can inspect the visible editor, take screenshots,
and send clicks, text, keyboard shortcuts, and drags. It can hold modifiers for
a gesture and supply PNG/JPEG bytes to an editor file chooser. Sign in through
the browser; its dedicated profile reuses the session between runs until Figma
requires sign-in again.

Connect through MCP stdio, or call the JSON HTTP API from your own tooling.
Keep the same browser setup when you switch agent clients or model providers.
The service runs independently of Figma's official MCP server and does not
require a Figma personal access token.

The browser profile and local service credential stay on your machine. Figma
still uses its cloud service, and tool results and screenshots go to your agent
client and any model provider it uses. Choose the agent accordingly.

## Install

You need **Node.js 22.16.0 or newer**, npm, and a graphical desktop for sign-in.
Chromium is installed in the next step.

**v0.1.0 release candidate:** the URL below is the planned GitHub release asset.
The asset is not yet published; the install command becomes usable when the
release is available. This is an npm-format archive, not a package published
to the npm registry. Recorded CLI and native browser fixtures have passed
on Linux, macOS, and Windows in the tested configurations; those results apply
to the recorded candidate archives. The new primitives have passed source
checks; their native qualification is in progress. Real authenticated Figma
editing remains unverified. See the
[tested Node/browser configurations and validation boundaries](docs/TESTING.md).

```sh
npm install --global https://github.com/ctxrs/figma-server/releases/download/v0.1.0/ctxrs-figma-server-0.1.0.tgz
```

Before publication, use a supplied candidate archive in place of that URL, or
[build from source](#development).

## Log in and connect your agent

In terminal 1:

```sh
figma-server init
figma-server browser-install
figma-server run
```

Keep `run` open. It owns the browser profile and listens on
`http://127.0.0.1:4317`. Stop it with Ctrl+C when finished.

Before Google or enterprise SSO login, [configure the exact provider origins](docs/operations.md#google-and-enterprise-sso) and restart the daemon.

In terminal 2:

```sh
figma-server login
figma-server status
```

`login` opens a dedicated browser window. Sign in to Figma there, complete any
required prompts, then press Enter in terminal 2. Credentials belong in the
browser. The service then checks that the session survives reopening the
profile headlessly.

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

## Try it

Give your agent a file URL your signed-in account can access:

> Open this Figma file in read mode, inspect the visible layers and controls,
> take a screenshot, and release the file. Tell me if editor access could not
> be verified.

For a first edit, use a disposable design file with edit access:

> In this test file, change the selected text to "Hello from my agent".
> Inspect the result and take a screenshot. Check the save indicator, then
> reload the file and check the text again. Release the file when done. If
> anything is unverified, stop and show me what you observed.

To try an image, supply a PNG or JPEG to your agent:

> Open this disposable file and find its image file chooser. Upload the supplied
> image bytes, inspect the result, and take a screenshot. Check saving and
> reopen the file before reporting success; tell me what remains unverified.

The upload tool delivers bytes to the chooser; insertion into the Figma document
and saving need separate checks. See the
[image and gesture examples](docs/agent-tools.md#supplying-an-image).

The agent keeps a short-lived lease while working in its tab. A writer lease
serializes this server's edits to the same file, and the agent releases it when
finished. [Agent tools](docs/agent-tools.md) has exact inputs and example flows.

## Know the limits

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
