# VS Code MCP Bridge

A VS Code extension that hosts a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) HTTP server, exposing your live IDE state to AI coding agents — active file, cursor position, LSP diagnostics, visual diffs, managed terminals, and more.

## Quickest way to get started

Just point your AI coding tool at this README and tell it to install the MCP for you.

## Features

- **27 MCP tools** covering file I/O, LSP, terminal, and VS Code UI
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
| `close_file` | Close a file tab (including diff tabs) |

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
| `apply_code_action` | Apply a code action by index (a command carried by the action must be in `mcpServer.allowedCommands`) |
| `rename_symbol` | Rename a symbol and all references workspace-wide |

### Terminal
| Tool | Description |
|---|---|
| `run_terminal_command` | Run a short-lived shell command and capture stdout/stderr |
| `spawn_terminal` | Spawn a long-running process (dev server, watch mode) with output capture |
| `list_terminals` | List all managed terminals and their status |
| `read_terminal` | Read recent output from a managed terminal |
| `write_terminal` | Send input to a managed terminal |
| `kill_terminal` | Kill a managed terminal and its process |

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
| `mcpServer.allowedCommands` | `[]` | VS Code command IDs allowed via `execute_vscode_command` and for commands carried by `apply_code_action` (empty = no commands) |
| `mcpServer.terminalStrategy` | `"childProcess"` | `childProcess` captures output reliably; `shellIntegration` shows in the VS Code terminal panel |

## Agent Behaviour

The server sends instructions to every connected agent on connect:

- Call `show_diff` before writing any file so changes are visible in VS Code first
- Call `get_active_file` and `get_selection` before answering questions about code
- Call `get_diagnostics` when diagnosing errors rather than guessing
- Use LSP tools (`go_to_definition`, `find_references`, `rename_symbol`) instead of text search for code navigation and refactoring
- Call `get_diagnostics` again after making changes to confirm no new errors were introduced
- Use `spawn_terminal` for long-running processes (dev servers, watch modes) instead of `run_terminal_command` which will timeout
- Use `read_terminal` to check on spawned process output, and `kill_terminal` to clean up when done

## Managed Terminals

The `spawn_terminal` tool creates long-running processes (dev servers, watch modes, background tasks) that persist across tool calls. Each spawned terminal:

- Appears in the VS Code terminal panel so you can see it running
- Captures all stdout/stderr in a 128 KB ring buffer (keeps the most recent output)
- Accepts input via `write_terminal` (e.g. answering prompts, sending commands)
- Can be killed with a configurable signal (`SIGTERM`, `SIGINT`, `SIGKILL`)

Typical orchestration flow:

```
spawn_terminal(name: "dev-server", command: "npm run dev")
spawn_terminal(name: "tests", command: "npm test -- --watch")

# ... later ...
read_terminal(id: "term_1", lines: 20)   # check dev server output
write_terminal(id: "term_2", input: "a")  # re-run all tests in jest
kill_terminal(id: "term_1")               # stop dev server
```

Use `run_terminal_command` for short-lived commands (build, lint, install) that should return output directly. Use `spawn_terminal` for anything that runs indefinitely or needs to be checked on later.

## Context Push

When `mcpServer.enableContextPush` is enabled, the server pushes events to connected agents whenever:

- The active file changes
- The selection/cursor moves
- Diagnostics update

Events arrive as MCP `notifications/message` log messages with `data.type` set to `activeFile`, `selection`, or `diagnostics`.

## Security

The server only listens on `127.0.0.1` (localhost) — it is not reachable from other machines on your network. For shared or remote environments, set `mcpServer.authToken` in VS Code settings to require a bearer token on all connections.

### Command authorization

`mcpServer.allowedCommands` is an allowlist: when it is empty, no command may run. The same check guards both `execute_vscode_command` and any command carried by a code action. `apply_code_action` authorizes a carried command before applying the action's edit, so a denied action produces no execution and no partial edit. Edit-only code actions do not need an allowlist entry. When an action carries both an edit and a command, the edit is applied and the command is not executed (the existing precedence).
