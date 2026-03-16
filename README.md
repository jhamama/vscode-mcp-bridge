# VS Code MCP Bridge

A VS Code extension that hosts a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) HTTP server, exposing your live IDE state to AI coding agents — active file, cursor position, LSP diagnostics, visual diffs, git status, and more.

## Quickest way to get started

Just point your AI coding tool at this README and tell it to install the MCP for you.

## Features

- **23 MCP tools** covering file I/O, LSP, git, terminal, and VS Code UI
- **Visual diffs** — agents call `show_diff` to open a native VS Code diff editor before any file is written
- **Live diagnostics** — exposes TypeScript, ESLint, and any other LSP errors to the agent in real time
- **Context push** — automatically notifies connected agents when the active file or selection changes
- **Works with any MCP client** — anything that speaks MCP over SSE

## Setup

### 1. Install the extension

Install from VSIX or the VS Code Marketplace. The server starts automatically when VS Code opens.

### 2. Connect your MCP client

The server runs on `http://127.0.0.1:3333` by default. Point your MCP client at:

```
http://127.0.0.1:3333/sse
```

Most tools have a config file or settings UI where you can add an MCP server — add the URL above as an SSE transport.

### 3. Verify

```bash
curl http://127.0.0.1:3333/health
```

## Commands (`Cmd+Shift+P`)

| Command | Description |
|---|---|
| `VS Code MCP Bridge: Start Server` | Start the HTTP server |
| `VS Code MCP Bridge: Stop Server` | Stop the HTTP server (disconnects all agents) |
| `VS Code MCP Bridge: Restart Server` | Restart the server (picks up port/settings changes) |
| `VS Code MCP Bridge: Show Status / Options` | Show connection count, copy URL, or stop |
| `VS Code MCP Bridge: Copy Connection URL` | Copy the SSE endpoint URL to clipboard |

The status bar item (bottom right) shows the current port and connected agent count. Click it to access the same options.

## Tools

### Context
| Tool | Description |
|---|---|
| `get_active_file` | Current file path, full content, and language |
| `get_selection` | Current text selection and cursor position |
| `get_open_tabs` | All open editor tabs |
| `get_workspace_info` | Workspace root, name, and folder structure |

### Files
| Tool | Description |
|---|---|
| `show_diff` | Opens a native VS Code diff editor — use before writing |
| `read_file` | Read file contents (supports line ranges) |
| `write_file` | Write content to a file (integrates with VS Code undo) |
| `create_file` | Create a new file |
| `delete_file` | Delete a file (moves to trash by default) |
| `open_file` | Open a file in the editor, optionally jump to a line |

### Language Server (LSP)
| Tool | Description |
|---|---|
| `get_diagnostics` | Errors and warnings from all language servers |
| `find_references` | Find all references to a symbol |
| `go_to_definition` | Get the definition location(s) of a symbol |
| `get_hover` | Type info and documentation for a symbol |
| `get_document_symbols` | All symbols (functions, classes, etc.) in a file |
| `search_workspace_symbols` | Search symbols across the entire workspace |
| `get_code_actions` | Available quick fixes and refactors for a range |
| `apply_code_action` | Apply a code action by index |
| `rename_symbol` | Rename a symbol and all references workspace-wide |

### Git
| Tool | Description |
|---|---|
| `get_git_status` | Current branch, staged and unstaged changes |
| `get_git_diff` | Diff for a file or the entire repo (staged or unstaged) |

### Terminal
| Tool | Description |
|---|---|
| `run_terminal_command` | Run a shell command and capture stdout/stderr |

### VS Code
| Tool | Description |
|---|---|
| `execute_vscode_command` | Execute any VS Code command (requires allowlist in settings) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `mcpServer.port` | `3333` | HTTP port for the MCP server |
| `mcpServer.enableContextPush` | `true` | Push active file/selection/diagnostic events to agents automatically |
| `mcpServer.authToken` | `""` | Bearer token for HTTP auth (empty = no auth) |
| `mcpServer.allowedCommands` | `[]` | VS Code command IDs allowed via `execute_vscode_command` |
| `mcpServer.terminalStrategy` | `"childProcess"` | `childProcess` captures output reliably; `shellIntegration` shows in the VS Code terminal panel |

## Agent Behaviour

The server sends instructions to every connected agent on connect:

- Call `show_diff` before writing any file so changes are visible in VS Code first
- Call `get_active_file` and `get_selection` before answering questions about code
- Call `get_diagnostics` when diagnosing errors rather than guessing
- Use LSP tools (`go_to_definition`, `find_references`, `rename_symbol`) instead of text search for code navigation and refactoring
- Call `get_diagnostics` again after making changes to confirm no new errors were introduced

## Context Push

When `mcpServer.enableContextPush` is enabled, the server pushes events to connected agents whenever:

- The active file changes
- The selection/cursor moves
- Diagnostics update

Events arrive as MCP `notifications/message` log messages with `data.type` set to `activeFile`, `selection`, or `diagnostics`.

## Security

The server only listens on `127.0.0.1` (localhost) — it is not reachable from other machines on your network. For shared or remote environments, set `mcpServer.authToken` in VS Code settings to require a bearer token on all connections.
