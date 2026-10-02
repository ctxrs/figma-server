# Skills and plugins

The repository includes a portable [Agent Skills](https://agentskills.io/specification)
skill and an [Agent Plugins 1.0](https://agent-plugins.org/specification) plugin.
The plugin contains the same skill plus MCP configuration. Installing either
does not install the server, launch Chromium, sign in, or start the daemon.
First follow [CLI installation](../README.md#install) and
[login and server setup](../README.md#log-in-and-connect-your-agent).
The plugin version starts at `0.1.0`; it requires server `0.2.0` or newer.

## Standalone skill

Use the [skills CLI](https://skills.sh/docs/cli):

```sh
npx skills add ctxrs/figma-server --skill figma-server
```

Select your agent in the installer. The skill needs the separately configured
MCP connection from the README, or an agent that calls the JSON HTTP API.
For a manual installation, copy the entire `skills/figma-server` folder into
your client's skills directory, including `references/`. All local references
stay inside that folder.

## Codex plugin

With a Codex CLI that supports plugins:

```sh
codex plugin marketplace add ctxrs/figma-server
codex plugin add figma-server@ctxrs-figma-server
```

The first command registers the repository marketplace; the second installs
the plugin. Restart or reconnect the client after installation as needed.
The plugin supplies the `figma-server mcp` configuration, so a separate manual
MCP entry is unnecessary for that plugin. The installed CLI must be on the
client's executable path and `figma-server run` must stay running. If the client
cannot find it, see [MCP launcher setup](operations.md#mcp-launcher-setup).

The same marketplace can be selected in the ChatGPT desktop app's Plugins
Directory. See [OpenAI's plugin guide](https://developers.openai.com/plugins/build/plugins)
for client setup. This is a repository marketplace, not a submission to a public
plugin directory or app store.

## Claude Code plugin

In Claude Code, use these slash commands:

```text
/plugin marketplace add ctxrs/figma-server
/plugin install figma-server@ctxrs-figma-server
```

The small `.claude-plugin/` adapter shares the plugin's identity, skill folder
and MCP command. Claude discovers `skills/` and reads the inline MCP configuration
from its own manifest. Keep the CLI on the client's executable path and the
server running, just as for Codex. These are client commands, not shell commands.

## Other plugin clients

A client supporting Agent Plugins 1.0 can load the repository root:
`plugin.json` identifies the package, `mcp.json` defines its stdio server, and
`skills/figma-server/SKILL.md` is discovered automatically. Client-specific
installation support varies. The MCP launcher handles the local daemon's
authentication without embedded tokens or environment secrets.
