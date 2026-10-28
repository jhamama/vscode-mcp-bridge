/**
 * Offline MCP smoke: real McpServer + Client over InMemoryTransport, the real
 * VsCodeBridge and registered public tools. Only the external `vscode` module
 * is faked (test/vscode-mock.ts). Prints observed effects as JSON.
 *
 * This is fixture evidence, not proof against a real installed VS Code.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { VsCodeBridge } from '../src/bridge/VsCodeBridge.js'
import { Settings } from '../src/config/Settings.js'
import { TerminalManager } from '../src/terminal/TerminalManager.js'
import { registerTools } from '../src/tools/index.js'
import { mockState, resetMockState, callsTo } from './vscode-mock.js'

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

interface Observation {
  case: string
  ok: boolean
  expected: Record<string, unknown>
  observed: Record<string, unknown>
}

const range = { filePath: '/tmp/issue90-smoke.ts', startLine: 0, startChar: 0, endLine: 0, endChar: 1 }
const observations: Array<Observation> = []
let failures = 0

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-issue90-smoke-'))
process.env.TMPDIR = tmpDir
const terminalManager = new TerminalManager()

async function openTools(allowedCommands: Array<string>) {
  resetMockState()
  mockState.config = { allowedCommands }

  const server = new McpServer({ name: 'bridge-smoke-server', version: '0.0.0' })
  registerTools(server, new VsCodeBridge(), new Settings(), terminalManager)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'bridge-smoke-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    call: async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async (): Promise<void> => {
      await client.close()
      await server.close()
    },
  }
}

function record(name: string, expected: Record<string, unknown>, observed: Record<string, unknown>): void {
  const ok = Object.keys(expected).length === Object.keys(observed).length
    && Object.entries(expected).every(([key, value]) => observed[key] === value)
  if (!ok) failures++
  observations.push({ case: name, ok, expected, observed })
}

async function run(): Promise<void> {
  // Deny: empty allowlist must permit nothing.
  {
    const tools = await openTools([])
    try {
      const result = await tools.call('execute_vscode_command', { command: 'demo.deniedDirect' })
      record('deny-direct-empty-allowlist', { isError: true, executions: 0 }, {
        isError: result.isError === true,
        executions: callsTo('demo.deniedDirect').length,
      })
    } finally {
      await tools.close()
    }
  }

  // Allow: an allowlisted command executes exactly once.
  {
    const tools = await openTools(['demo.allowedDirect'])
    try {
      const result = await tools.call('execute_vscode_command', { command: 'demo.allowedDirect' })
      record('allow-direct', { isError: false, executions: 1 }, {
        isError: result.isError === true,
        executions: callsTo('demo.allowedDirect').length,
      })
    } finally {
      await tools.close()
    }
  }

  // Deny: a code action carrying a non-allowlisted command executes nothing and edits nothing.
  {
    const tools = await openTools(['demo.allowedDirect'])
    mockState.codeActions = [{
      title: 'Denied action command',
      command: { title: 'Denied action command', command: 'demo.deniedAction', arguments: [{ target: 'x' }] },
    }]
    try {
      const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
      record('deny-action-command', { isError: true, executions: 0, edits: 0 }, {
        isError: result.isError === true,
        executions: callsTo('demo.deniedAction').length,
        edits: mockState.appliedEdits.length,
      })
    } finally {
      await tools.close()
    }
  }

  // Edit-only actions still apply with an empty allowlist and execute no command.
  {
    const tools = await openTools([])
    const edit = { changes: { 'file:///tmp/issue90-smoke.ts': [] } }
    mockState.codeActions = [{ title: 'Edit-only action', edit }]
    try {
      const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
      record('edit-only-action', { isError: false, applied: true, edits: 1, executions: 0 }, {
        isError: result.isError === true,
        applied: (JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>).applied,
        edits: mockState.appliedEdits.length,
        executions: mockState.commandCalls.filter(call => call.command !== 'vscode.executeCodeActionProvider').length,
      })
    } finally {
      await tools.close()
    }
  }

  // Deny: combined edit+command with a denied command must not apply the edit.
  {
    const tools = await openTools(['demo.allowedDirect'])
    mockState.codeActions = [{
      title: 'Denied combined action',
      edit: { changes: { 'file:///tmp/issue90-smoke.ts': [] } },
      command: { title: 'Denied combined action', command: 'demo.deniedCombined', arguments: [] },
    }]
    try {
      const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
      record('deny-combined-no-edit', { isError: true, executions: 0, edits: 0 }, {
        isError: result.isError === true,
        executions: callsTo('demo.deniedCombined').length,
        edits: mockState.appliedEdits.length,
      })
    } finally {
      await tools.close()
    }
  }
}

try {
  await run()
} catch (error) {
  failures++
  observations.push({
    case: 'unexpected-error',
    ok: false,
    expected: { error: null },
    observed: { error: error instanceof Error ? error.message : String(error) },
  })
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

if (observations.length !== 5) failures++

console.log(JSON.stringify({ ok: failures === 0, cases: observations }, null, 2))
if (failures > 0) process.exitCode = 1
