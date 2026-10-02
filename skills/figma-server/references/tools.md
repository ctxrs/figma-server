# JavaScript and persistent CDP examples

These are tool argument objects, not shell commands. Replace `LEASE_UUID` with
the UUID from a successful writer `figma.open` in the same client session.
Client tool names may add a server prefix to the underlying `figma.*` names.

For `figma.evaluate`:

```json
{
  "lease": "LEASE_UUID",
  "expression": "Promise.resolve({title: document.title})",
  "await_promise": true,
  "timeout_ms": 10000
}
```

Read a serializable value at `result.result.value`. JavaScript exceptions return
`status: "failed"` and retain `result.exceptionDetails`. Raw output is unredacted
and bounded to 1 MiB; request a focused value rather than dumping page state.
JavaScript access does not create a native Figma node API.

For `figma.cdp`, enable events on the persistent tab connection:

```json
{"lease":"LEASE_UUID","scope":"tab","command":"Runtime.enable"}
```

For `figma.cdp_events`, poll that same connection:

```json
{"lease":"LEASE_UUID","scope":"tab","after":0,"limit":100,"wait_ms":1000}
```

Continue with the returned `cursor` as `after`, polling while `has_more` is true.
Check `dropped_events`, `oldest_cursor` and `closed`; the bounded buffer can lose
history. After `figma.cdp_close` and a new connection, restart at `after: 0`.
Protocol errors retain useful details; a successful command response is not an
edit or save receipt. An output-limit error does not undo a command's effects.

For `figma.cdp` with browser scope:

```json
{"lease":"LEASE_UUID","scope":"browser","command":"Browser.getVersion"}
```

There is no method whitelist. Browser scope shares the account's worker with
other agents; scope does not isolate tabs or state. Connections are separate
per lease/scope and detach on lease release. Raw-created pages remain until
their owner closes them or the browser stops.

The `targetId` from `figma.open` is a broker handle, not a native Chrome target
ID. For a native ID, call `Target.getTargetInfo` on tab scope and use
`result.targetInfo.targetId`. CDP child attachment `sessionId` is also distinct
from the client session. Child messaging uses `Target.attachToTarget` with
`flatten: false`, then `Target.sendMessageToTarget`; receive replies through
`Target.receivedMessageFromTarget` events and correlate message IDs. There is no
top-level child `sessionId` field in `figma.cdp`.
