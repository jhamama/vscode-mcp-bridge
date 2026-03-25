import * as http from 'http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { VsCodeBridge } from '../bridge/VsCodeBridge.js'
import { ContextPusher } from '../context/ContextPusher.js'
import { TerminalManager } from '../terminal/TerminalManager.js'
import { registerTools } from '../tools/index.js'
import type { Settings } from '../config/Settings.js'
import { log } from '../utils/logger.js'

interface SessionEntry {
  transport: SSEServerTransport
  unsubscribePush: () => void
}

export class HttpServer {
  private httpServer: http.Server
  private sessions = new Map<string, SessionEntry>()
  private actualPort = 0

  constructor(
    private bridge: VsCodeBridge,
    private pusher: ContextPusher,
    private settings: Settings,
    private terminalManager: TerminalManager,
  ) {
    this.httpServer = http.createServer(this.handleRequest.bind(this))
  }

  get connectionCount(): number {
    return this.sessions.size
  }

  get port(): number {
    return this.actualPort
  }

  async start(preferredPort: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = preferredPort + attempt
      try {
        await new Promise<void>((resolve, reject) => {
          this.httpServer.listen(port, '127.0.0.1', () => resolve())
          this.httpServer.once('error', reject)
        })
        this.actualPort = port
        return port
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      }
    }
    throw new Error(`Could not bind to any port in range ${preferredPort}-${preferredPort + 4}`)
  }

  async stop(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.unsubscribePush()
    }
    this.sessions.clear()
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const token = this.settings.authToken
    if (!token) return true
    const header = req.headers['authorization'] ?? ''
    return header === `Bearer ${token}`
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        version: '0.2.5',
        connectedAgents: this.sessions.size,
        port: this.actualPort,
      }))
      return
    }

    if (!this.checkAuth(req)) {
      log.warn('Server', `Unauthorized request to ${req.url}`)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (req.url === '/sse' && req.method === 'GET') {
      await this.handleSse(req, res)
      return
    }

    if (req.url?.startsWith('/messages') && req.method === 'POST') {
      await this.handleMessages(req, res)
      return
    }

    res.writeHead(404)
    res.end()
  }

  private async handleSse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const transport = new SSEServerTransport('/messages', res)
    const sessionId = transport.sessionId

    // Create a new McpServer per connection (SDK design requires this)
    const mcpServer = new McpServer(
      { name: 'vscode-mcp-bridge', version: '0.2.5' },
      {
        instructions: `You are connected to a live VS Code instance. The following suggestions can help you get the most out of these tools:

WRITING FILES:
- Consider calling show_diff before write_file or create_file so the user can review changes visually in VS Code before they are applied.

UNDERSTANDING CONTEXT:
- When a user asks about code, consider calling get_active_file and get_selection to see what they are currently looking at.
- When diagnosing errors, get_diagnostics can provide LSP errors which are often more accurate than guessing.

NAVIGATING CODE:
- go_to_definition can locate where a symbol is defined, often faster than searching by text.
- find_references can help you understand the blast radius of a change.
- get_document_symbols gives a structural overview of a file.
- search_workspace_symbols can locate a type, function, or class across the whole project.

MAKING CHANGES:
- rename_symbol is refactor-safe and workspace-wide — often better than find-and-replace for identifiers.
- After making changes, get_diagnostics can confirm no new errors were introduced.

RUNNING COMMANDS:
- run_terminal_command works well for short-lived commands (build, test, lint, install).

LONG-RUNNING PROCESSES:
- spawn_terminal is designed for processes that run indefinitely — dev servers, watch modes, docker compose, tail -f, etc.
- list_terminals shows all managed terminals and whether they are still alive.
- read_terminal lets you check on output later. You can request the last N lines to avoid reading the entire buffer.
- write_terminal sends input to a running process (e.g. answer a prompt, type a command).
- kill_terminal stops a process and cleans up.
- Note: run_terminal_command will timeout on long-running processes — use spawn_terminal instead.

GENERAL:
- get_workspace_info can orient you at the start of a session if you don't know the workspace root or tech stack.
- VS Code's native tools (LSP, git, symbols) are often faster and more semantically aware than raw file search.`,
      },
    )
    registerTools(mcpServer, this.bridge, this.settings, this.terminalManager)

    // Wire context push events, but gate on initialization
    let initialized = false
    const unsubscribePush = this.settings.enableContextPush
      ? this.pusher.onPush((type, payload) => {
          if (!initialized) return
          try {
            transport.send({
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: {
                level: 'info',
                logger: 'vscode-mcp',
                data: { type, payload },
              },
            }).catch(() => undefined)
          } catch { /* connection may have closed */ }
        })
      : () => undefined

    this.sessions.set(sessionId, { transport, unsubscribePush })
    log.info('Server', `SSE session connected: ${sessionId} (total: ${this.sessions.size})`)

    req.on('close', () => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.unsubscribePush()
        this.sessions.delete(sessionId)
        log.info('Server', `SSE session disconnected: ${sessionId} (total: ${this.sessions.size})`)
      }
    })

    // Start connection — enable push notifications after a delay to allow handshake to complete
    setTimeout(() => { initialized = true }, 2000)
    await mcpServer.connect(transport)
  }

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://localhost`)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const session = this.sessions.get(sessionId)

    if (!session) {
      log.warn('Server', `Message for unknown session: ${sessionId}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session not found' }))
      return
    }

    await session.transport.handlePostMessage(req, res)
  }
}
