---
name: figma-server
description: Inspect, screenshot, edit and verify accessible Figma files through a running figma-server browser. Use for hands-on Figma work with its MCP or JSON HTTP tools, including page JavaScript and persistent CDP commands and events.
license: Apache-2.0
compatibility: Requires figma-server 0.2.0 or newer installed and running, a signed-in dedicated Chromium profile, and an agent connected through MCP or the authenticated JSON HTTP API. Initial sign-in needs a graphical desktop; the daemon runs headlessly afterward.
---

# Work in Figma with figma-server

Use the user's Figma account and an existing file URL they can access. Account
permissions still apply. Use the requested account; `default` is the usual
configured account. Do not guess a file from its name or switch to another file
when entry fails. Plain Design file URLs are the tested entry path; opening a
URL with node/page selection can be unsupported.

## Check the connection

The skill supplies instructions, not a running server. The plugin also supplies
MCP configuration; neither installs Chromium, signs in, nor starts the daemon.
If tools are missing, use the [setup guide](https://github.com/ctxrs/figma-server#log-in-and-connect-your-agent).
Install the released CLI as shown in the [README](https://github.com/ctxrs/figma-server#install),
then run `figma-server init`, `figma-server browser-install`, `figma-server login`
and `figma-server run`. Configure exact Google/SSO origins before login when
needed, using [Operations](https://github.com/ctxrs/figma-server/blob/main/docs/operations.md#google-and-enterprise-sso).
Login needs the operator's browser interaction. Keep `run` running. The MCP
launcher is `figma-server mcp`; it connects to that daemon and handles its local
authentication automatically.

## Open, observe, act, verify

- Check `figma.account_status` before opening. Report missing login or readiness
  instead of attempting credential retrieval or an automated login.
- Call `figma.open` with the exact `file_url` and explicit `mode`: `read` for
  inspection helpers, `write` for edits or any raw JavaScript/CDP tool. Keep the
  returned lease UUID in the same client session. The default mode is `write`.
- Start with `figma.inspect` and `figma.screenshot`. Use controls and labels
  observed in that editor, or screenshot coordinates, for the requested edit.
  A visible layer label is not proof of its text content or native node type.
- After a write, inspect the affected control or use `figma.read_value` with an
  observed locator. Check a visible save indicator when one exists. Readback,
  saving and persistence are separate observations: a dispatched input or a
  completed protocol command does not establish any of them.
- For a persistence check, release and reopen the same file, reselect the same
  object and read its values again. State exactly what was observed. A same-profile
  reopen is not an independent cloud transaction guarantee; leave save state
  unknown when the editor supplies no identifiable indicator.

Use `figma.heartbeat` during long tasks or pauses before the two-minute lease
and client-session expiry. Managed operations allow one writer per file; they
do not coordinate human collaborators. Avoid simultaneous edits to the same
elements. An expired lease or a new client session requires a fresh open and
inspection, not reuse of the old UUID.

## JavaScript and full CDP

Use `figma.evaluate` for page JavaScript and `figma.cdp` for arbitrary protocol
commands. All raw tools, including event polling and connection closure, need
an owned writer lease. Default `tab` scope targets its managed tab; choose
`browser` only when the task needs the shared account browser. Raw authority can
bypass file locks and affect other agents' tabs and shared browser state in
either scope. Stay within the user's task and coordinate shared effects.

Connections persist per lease and scope. Enable needed domains, poll
`figma.cdp_events` using its continuation cursor, and check overflow and closure
before treating events as complete. Resume/continue commands can run while a
raw call is paused. Read [tools.md](references/tools.md) for argument examples,
result interpretation and native target IDs.

Page JavaScript does not provide `window.figma`, the Figma plugin API, or a
complete native node model. Do not invent those capabilities. Inspect returned
values, JavaScript exception details and protocol errors. A timeout or output
limit can follow an action that already took effect: inspect the state before
retrying, especially for writes. UI helper errors can invalidate a lease;
reopen and inspect rather than repeating an uncertain edit.

## Finish

Detach any child CDP sessions and close only raw targets you created.
`figma.cdp_close` detaches that lease/scope connection; it does not stop the
shared browser or release the file. Release each owned lease with
`figma.release` when finished, including on failure. Do not shut down a shared
browser or close another agent's tab as routine cleanup. Report verified results
and any remaining uncertainty.

For less common inputs, use the [full tool guide](https://github.com/ctxrs/figma-server/blob/main/docs/agent-tools.md).
