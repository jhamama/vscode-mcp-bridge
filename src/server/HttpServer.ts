import * as http from 'http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { VsCodeBridge } from '../bridge/VsCodeBridge.js'
import { ContextPusher } from '../context/ContextPusher.js'
import { registerTools } from '../tools/index.js'
import type { Settings } from '../config/Settings.js'

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
        version: '0.1.0',
        connectedAgents: this.sessions.size,
        port: this.actualPort,
      }))
      return
    }

    if (!this.checkAuth(req)) {
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
      { name: 'vscode-mcp-bridge', version: '0.1.0' },
      {
        instructions: `You are connected to a live VS Code instance. Follow these behaviours:

BEFORE WRITING FILES:
- Always call show_diff before write_file or create_file so the user can review changes visually in VS Code before they are applied. This is non-negotiable — never skip this step.

UNDERSTANDING CONTEXT:
- When a user asks about code ("explain this", "what does this do", "why is this failing"), first call get_active_file and get_selection to see exactly what they are looking at. Do not guess file paths.
- When diagnosing errors or unexpected behaviour, call get_diagnostics for the relevant file before drawing conclusions. LSP errors are more reliable than inference.

NAVIGATING CODE:
- Use go_to_definition to locate where a symbol is defined rather than searching by text.
- Use find_references to understand the blast radius of a change before making it.
- Use get_document_symbols to get a structural overview of a file before reading it line by line.
- Use search_workspace_symbols to locate a type, function, or class across the whole project.

MAKING CHANGES:
- Prefer rename_symbol over a find-and-replace when renaming identifiers — it is refactor-safe and workspace-wide.
- After applying changes, call get_diagnostics again to confirm no new errors were introduced.
- Use get_git_diff to review what has changed before asking the user to commit.

RUNNING COMMANDS:
- Use run_terminal_command for build, test, lint, and install operations. Capture and surface stdout/stderr in your response.

GENERAL:
- Call get_workspace_info at the start of a session if you do not yet know the workspace root or tech stack.
- Prefer VS Code's native tools (LSP, git, symbols) over raw file search where possible — they are faster and semantically aware.`,
      },
    )
    registerTools(mcpServer, this.bridge, this.settings)

    // Wire context push events to this connection
    const unsubscribePush = this.settings.enableContextPush
      ? this.pusher.onPush((type, payload) => {
          try {
            // Send as MCP log notification - agents can filter by data.type
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

    req.on('close', () => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.unsubscribePush()
        this.sessions.delete(sessionId)
      }
    })

    await mcpServer.connect(transport)
  }

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://localhost`)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const session = this.sessions.get(sessionId)

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session not found' }))
      return
    }

    await session.transport.handlePostMessage(req, res)
  }
}
