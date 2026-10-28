import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
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

let terminalManager: TerminalManager
let tmpDir: string

before(() => {
  // Keep the real TerminalManager's log-directory housekeeping inside a sandbox.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-issue90-'))
  process.env.TMPDIR = tmpDir
  terminalManager = new TerminalManager()
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function openTools(allowedCommands: Array<string>) {
  resetMockState()
  mockState.config = { allowedCommands }

  const server = new McpServer({ name: 'bridge-test-server', version: '0.0.0' })
  registerTools(server, new VsCodeBridge(), new Settings(), terminalManager)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'bridge-test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      return (await client.callTool({ name, arguments: args })) as ToolResult
    },
    async close(): Promise<void> {
      await client.close()
      await server.close()
    },
  }
}

function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content?.[0]?.text ?? '{}'
  return JSON.parse(text) as Record<string, unknown>
}

function assertDenied(result: ToolResult, commandId: string): void {
  assert.equal(result.isError, true, 'denied tool call must surface as an MCP tool error')
  assert.equal(callsTo(commandId).length, 0, `denied command ${commandId} must never reach vscode.commands.executeCommand`)
}

const range = { filePath: '/tmp/issue90-fixture.ts', startLine: 0, startChar: 0, endLine: 0, endChar: 1 }

test('execute_vscode_command denies every command when allowedCommands is empty', async () => {
  const tools = await openTools([])
  try {
    const result = await tools.call('execute_vscode_command', { command: 'demo.notAllowed', args: [{ nested: true }] })
    assertDenied(result, 'demo.notAllowed')
  } finally {
    await tools.close()
  }
})

test('execute_vscode_command denies a command missing from a non-empty allowlist', async () => {
  const tools = await openTools(['demo.allowed'])
  try {
    const result = await tools.call('execute_vscode_command', { command: 'demo.denied', args: [] })
    assertDenied(result, 'demo.denied')
  } finally {
    await tools.close()
  }
})

test('execute_vscode_command executes an allowlisted command exactly once', async () => {
  const tools = await openTools(['demo.allowed'])
  try {
    const result = await tools.call('execute_vscode_command', { command: 'demo.allowed' })
    assert.notEqual(result.isError, true)
    assert.equal(callsTo('demo.allowed').length, 1, 'allowlisted command must reach vscode.commands.executeCommand exactly once')
  } finally {
    await tools.close()
  }
})

test('apply_code_action denies a bare command when allowedCommands is empty', async () => {
  const tools = await openTools([])
  mockState.codeActions = [{ title: 'Bare command action', command: 'demo.deniedBare' }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assertDenied(result, 'demo.deniedBare')
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action denies a CodeAction.command object missing from a non-empty allowlist', async () => {
  const tools = await openTools(['demo.allowed'])
  mockState.codeActions = [{
    title: 'Object command action',
    command: { title: 'Object command action', command: 'demo.deniedObject', arguments: [{ target: 'x' }] },
  }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assertDenied(result, 'demo.deniedObject')
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action executes an allowlisted CodeAction.command exactly once', async () => {
  const tools = await openTools(['demo.allowedObject'])
  mockState.codeActions = [{
    title: 'Allowed object command',
    command: { title: 'Allowed object command', command: 'demo.allowedObject', arguments: [{ target: 'x' }] },
  }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assert.notEqual(result.isError, true)
    assert.equal(payload(result).applied, true)
    assert.equal(callsTo('demo.allowedObject').length, 1, 'allowlisted action command must execute exactly once')
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action applies an edit-only action with an empty allowlist', async () => {
  const tools = await openTools([])
  const edit = { changes: { 'file:///tmp/issue90-fixture.ts': [] } }
  mockState.codeActions = [{ title: 'Edit-only action', edit }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assert.notEqual(result.isError, true)
    assert.equal(payload(result).applied, true)
    assert.equal(mockState.appliedEdits.length, 1, 'edit must be applied exactly once')
    assert.equal(mockState.commandCalls.filter(call => call.command !== 'vscode.executeCodeActionProvider').length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action applies no edit when a combined edit+command action carries a denied command', async () => {
  const tools = await openTools(['demo.allowed'])
  const edit = { changes: { 'file:///tmp/issue90-fixture.ts': [] } }
  mockState.codeActions = [{
    title: 'Combined action',
    edit,
    command: { title: 'Combined action', command: 'demo.deniedCombined', arguments: [] },
  }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assertDenied(result, 'demo.deniedCombined')
    assert.equal(mockState.appliedEdits.length, 0, 'authorization must fail before the edit is applied')
  } finally {
    await tools.close()
  }
})

test('apply_code_action keeps edit precedence for a combined allowed edit+command action', async () => {
  const tools = await openTools(['demo.allowedCombined'])
  const edit = { changes: {} }
  mockState.codeActions = [{
    title: 'Combined allowed action',
    edit,
    command: { title: 'Combined allowed action', command: 'demo.allowedCombined', arguments: [] },
  }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assert.notEqual(result.isError, true)
    assert.equal(payload(result).applied, true)
    assert.equal(mockState.appliedEdits.length, 1, 'combined action must apply its edit exactly once')
    assert.equal(callsTo('demo.allowedCombined').length, 0, 'baseline behaviour applies the edit and skips the carried command')
  } finally {
    await tools.close()
  }
})

test('apply_code_action executes an allowlisted bare command exactly once', async () => {
  const tools = await openTools(['demo.allowedBare'])
  mockState.codeActions = [{ title: 'Allowed bare command', command: 'demo.allowedBare' }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assert.notEqual(result.isError, true)
    assert.equal(payload(result).applied, true)
    assert.equal(callsTo('demo.allowedBare').length, 1)
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action denies a bare command missing from a non-empty allowlist', async () => {
  const tools = await openTools(['demo.allowedBare'])
  mockState.codeActions = [{ title: 'Denied bare command', command: 'demo.deniedBare' }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assertDenied(result, 'demo.deniedBare')
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})

test('apply_code_action denies a CodeAction.command object when allowedCommands is empty', async () => {
  const tools = await openTools([])
  mockState.codeActions = [{
    title: 'Denied object command',
    command: { title: 'Denied object command', command: 'demo.deniedObject' },
  }]
  try {
    const result = await tools.call('apply_code_action', { ...range, actionIndex: 0 })
    assertDenied(result, 'demo.deniedObject')
    assert.equal(mockState.appliedEdits.length, 0)
  } finally {
    await tools.close()
  }
})
