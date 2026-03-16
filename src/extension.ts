import * as vscode from 'vscode'
import { VsCodeBridge } from './bridge/VsCodeBridge.js'
import { ContextPusher } from './context/ContextPusher.js'
import { HttpServer } from './server/HttpServer.js'
import { Settings } from './config/Settings.js'

let httpServer: HttpServer | undefined
let statusBarItem: vscode.StatusBarItem | undefined
let contextPusher: ContextPusher | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = new Settings()
  const bridge = new VsCodeBridge()

  // Register in-memory FS for diff previews
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('vscode-mcp-preview', bridge.memFs, {
      isCaseSensitive: true,
      isReadonly: true,
    })
  )

  // Context pusher (auto-push events to connected agents)
  contextPusher = new ContextPusher(bridge)
  if (settings.enableContextPush) {
    contextPusher.start()
  }

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'mcpServer.showStatus'
  context.subscriptions.push(statusBarItem)

  // Start HTTP server
  httpServer = new HttpServer(bridge, contextPusher, settings)

  async function startServer(): Promise<void> {
    try {
      const port = await httpServer!.start(settings.port)
      updateStatusBar(port, 0)
      vscode.window.showInformationMessage(`MCP Server running on http://127.0.0.1:${port}`)
    } catch (err) {
      vscode.window.showErrorMessage(`MCP Server failed to start: ${err}`)
      updateStatusBar(0, 0, true)
    }
  }

  async function stopServer(): Promise<void> {
    if (httpServer) {
      await httpServer.stop()
      updateStatusBar(0, 0)
      vscode.window.showInformationMessage('MCP Server stopped.')
    }
  }

  function updateStatusBar(port: number, agents: number, error = false): void {
    if (!statusBarItem) return
    if (error) {
      statusBarItem.text = '$(error) MCP Error'
      statusBarItem.tooltip = 'MCP Server failed to start. Click for options.'
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    } else if (port === 0) {
      statusBarItem.text = '$(circle-slash) MCP Stopped'
      statusBarItem.tooltip = 'MCP Server is stopped. Click to start.'
      statusBarItem.backgroundColor = undefined
    } else {
      statusBarItem.text = `$(radio-tower) MCP :${port}${agents > 0 ? ` | ${agents} agent${agents !== 1 ? 's' : ''}` : ''}`
      statusBarItem.tooltip = `MCP Server running on port ${port}. Click for options.`
      statusBarItem.backgroundColor = undefined
    }
    statusBarItem.show()
  }

  // Update agent count on connections changing
  setInterval(() => {
    if (httpServer && httpServer.port > 0) {
      updateStatusBar(httpServer.port, httpServer.connectionCount)
    }
  }, 2000)

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mcpServer.start', startServer),
    vscode.commands.registerCommand('mcpServer.stop', stopServer),
    vscode.commands.registerCommand('mcpServer.restart', async () => {
      await stopServer()
      await startServer()
    }),
    vscode.commands.registerCommand('mcpServer.copyConnectionUrl', async () => {
      if (!httpServer || httpServer.port === 0) {
        vscode.window.showWarningMessage('MCP Server is not running.')
        return
      }
      const url = `http://127.0.0.1:${httpServer.port}/sse`
      await vscode.env.clipboard.writeText(url)
      vscode.window.showInformationMessage(`Copied: ${url}`)
    }),
    vscode.commands.registerCommand('mcpServer.showStatus', async () => {
      if (!httpServer || httpServer.port === 0) {
        const choice = await vscode.window.showQuickPick(['Start Server'], { placeHolder: 'MCP Server is stopped' })
        if (choice === 'Start Server') await startServer()
        return
      }
      const url = `http://127.0.0.1:${httpServer.port}/sse`
      const choice = await vscode.window.showQuickPick(
        [`Connected agents: ${httpServer.connectionCount}`, 'Copy connection URL', 'Stop server'],
        { placeHolder: `MCP Server on port ${httpServer.port}` }
      )
      if (choice === 'Copy connection URL') {
        await vscode.env.clipboard.writeText(url)
        vscode.window.showInformationMessage(`Copied: ${url}`)
      } else if (choice === 'Stop server') {
        await stopServer()
      }
    }),
  )

  // Restart server if settings change
  context.subscriptions.push(
    settings.onChange(async () => {
      await stopServer()
      if (settings.enableContextPush) {
        contextPusher?.start()
      } else {
        contextPusher?.stop()
      }
      await startServer()
    })
  )

  // Auto-start
  await startServer()
}

export async function deactivate(): Promise<void> {
  contextPusher?.stop()
  await httpServer?.stop()
}
