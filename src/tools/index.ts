import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { VsCodeBridge } from '../bridge/VsCodeBridge.js'
import type { Settings } from '../config/Settings.js'

function symbolKindName(kind: number): string {
  const kinds = ['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor',
    'Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object',
    'Key','Null','EnumMember','Struct','Event','Operator','TypeParameter']
  return kinds[kind] ?? 'Unknown'
}

function serializeSymbols(symbols: Array<{ name: string; kind: number; range: { start: { line: number; character: number }; end: { line: number; character: number } }; detail?: string; children?: Array<unknown> }>): unknown {
  return symbols.map(s => ({
    name: s.name,
    kind: symbolKindName(s.kind),
    startLine: s.range.start.line,
    endLine: s.range.end.line,
    detail: s.detail ?? null,
    children: s.children ? serializeSymbols(s.children as Parameters<typeof serializeSymbols>[0]) : [],
  }))
}

export function registerTools(server: McpServer, bridge: VsCodeBridge, settings: Settings): void {

  // --- Active File ---
  server.tool('get_active_file', 'Get the currently active/open file in VS Code', {}, async () => {
    const snap = bridge.getActiveFileSnapshot()
    return { content: [{ type: 'text', text: JSON.stringify(snap) }] }
  })

  // --- Selection ---
  server.tool('get_selection', 'Get the current text selection and cursor position', {}, async () => {
    const snap = bridge.getSelectionSnapshot()
    return { content: [{ type: 'text', text: JSON.stringify(snap) }] }
  })

  // --- Open Tabs ---
  server.tool('get_open_tabs', 'Get all currently open file tabs in VS Code', {}, async () => {
    const tabs = bridge.getOpenTabs()
    return { content: [{ type: 'text', text: JSON.stringify(tabs) }] }
  })

  // --- Diagnostics ---
  server.tool(
    'get_diagnostics',
    'Get LSP diagnostics (errors, warnings, hints) from VS Code language servers',
    {
      filePath: z.string().optional().describe('Absolute path to a specific file, or omit for all open files'),
      severity: z.enum(['error', 'warning', 'information', 'hint']).optional().describe('Filter by minimum severity'),
    },
    async ({ filePath, severity }) => {
      let diags = bridge.getDiagnostics(filePath)
      if (severity) {
        const levels = ['hint', 'information', 'warning', 'error']
        const minLevel = levels.indexOf(severity)
        diags = diags.filter(d => levels.indexOf(d.severity) >= minLevel)
      }
      return { content: [{ type: 'text', text: JSON.stringify(diags) }] }
    }
  )

  // --- Show Diff ---
  server.tool(
    'show_diff',
    'Show a visual diff in VS Code before applying file changes. Does NOT write the file.',
    {
      filePath: z.string().describe('Absolute path to the file to diff'),
      newContent: z.string().describe('The proposed new content to show in the diff'),
      title: z.string().optional().describe('Title for the diff editor tab'),
    },
    async ({ filePath, newContent, title }) => {
      await bridge.showDiff(filePath, newContent, title)
      return { content: [{ type: 'text', text: JSON.stringify({ shown: true, filePath }) }] }
    }
  )

  // --- Read File ---
  server.tool(
    'read_file',
    'Read the contents of a file',
    {
      filePath: z.string().describe('Absolute path to the file'),
      startLine: z.number().int().min(0).optional().describe('Start line (0-indexed, inclusive)'),
      endLine: z.number().int().min(0).optional().describe('End line (0-indexed, inclusive)'),
    },
    async ({ filePath, startLine, endLine }) => {
      const result = await bridge.readFile(filePath, startLine, endLine)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Write File ---
  server.tool(
    'write_file',
    'Write content to a file. Integrates with VS Code undo history.',
    {
      filePath: z.string().describe('Absolute path to the file'),
      content: z.string().describe('The full content to write'),
      createIfMissing: z.boolean().optional().default(true).describe('Create the file if it does not exist'),
    },
    async ({ filePath, content, createIfMissing }) => {
      const result = await bridge.writeFile(filePath, content, createIfMissing)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Create File ---
  server.tool(
    'create_file',
    'Create a new file',
    {
      filePath: z.string().describe('Absolute path for the new file'),
      content: z.string().optional().default('').describe('Initial content'),
    },
    async ({ filePath, content }) => {
      await bridge.createFile(filePath, content)
      return { content: [{ type: 'text', text: JSON.stringify({ created: true, filePath }) }] }
    }
  )

  // --- Delete File ---
  server.tool(
    'delete_file',
    'Delete a file',
    {
      filePath: z.string().describe('Absolute path to the file to delete'),
      useTrash: z.boolean().optional().default(true).describe('Move to trash instead of permanent delete'),
    },
    async ({ filePath, useTrash }) => {
      await bridge.deleteFile(filePath, useTrash)
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, filePath }) }] }
    }
  )

  // --- Open File ---
  server.tool(
    'open_file',
    'Open a file in the VS Code editor',
    {
      filePath: z.string().describe('Absolute path to the file'),
      line: z.number().int().min(0).optional().describe('Line to jump to (0-indexed)'),
      character: z.number().int().min(0).optional().describe('Character position'),
      preview: z.boolean().optional().default(false).describe('Open in preview mode'),
    },
    async ({ filePath, line, character, preview }) => {
      await bridge.openFile(filePath, line, character, preview)
      return { content: [{ type: 'text', text: JSON.stringify({ opened: true, filePath }) }] }
    }
  )

  // --- Run Terminal Command ---
  server.tool(
    'run_terminal_command',
    'Run a shell command and capture its output',
    {
      command: z.string().describe('The shell command to run'),
      cwd: z.string().optional().describe('Working directory (defaults to workspace root)'),
      timeoutMs: z.number().int().min(1000).optional().default(30000).describe('Timeout in milliseconds'),
    },
    async ({ command, cwd, timeoutMs }) => {
      const strategy = settings.get<string>('terminalStrategy') ?? 'childProcess'
      const result = await bridge.runCommand(command, cwd, timeoutMs, strategy)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Find References ---
  server.tool(
    'find_references',
    'Find all references to a symbol at a given position using LSP',
    {
      filePath: z.string().describe('Absolute path to the file'),
      line: z.number().int().min(0).describe('Line number (0-indexed)'),
      character: z.number().int().min(0).describe('Character position (0-indexed)'),
      includeDeclaration: z.boolean().optional().default(true),
    },
    async ({ filePath, line, character, includeDeclaration }) => {
      const refs = await bridge.getReferences(filePath, line, character, includeDeclaration)
      const serialized = (refs ?? []).map(r => ({
        filePath: r.uri.fsPath,
        startLine: r.range.start.line,
        startChar: r.range.start.character,
        endLine: r.range.end.line,
        endChar: r.range.end.character,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Go To Definition ---
  server.tool(
    'go_to_definition',
    'Get the definition location(s) of a symbol at a given position using LSP',
    {
      filePath: z.string().describe('Absolute path to the file'),
      line: z.number().int().min(0).describe('Line number (0-indexed)'),
      character: z.number().int().min(0).describe('Character position (0-indexed)'),
    },
    async ({ filePath, line, character }) => {
      const defs = await bridge.getDefinition(filePath, line, character)
      const serialized = (defs ?? []).map(d => {
        if ('uri' in d) {
          return { filePath: d.uri.fsPath, startLine: d.range.start.line, startChar: d.range.start.character, endLine: d.range.end.line, endChar: d.range.end.character }
        }
        return { filePath: d.targetUri.fsPath, startLine: d.targetRange.start.line, startChar: d.targetRange.start.character, endLine: d.targetRange.end.line, endChar: d.targetRange.end.character }
      })
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Get Hover ---
  server.tool(
    'get_hover',
    'Get hover information (type info, documentation) for a symbol at a given position',
    {
      filePath: z.string().describe('Absolute path to the file'),
      line: z.number().int().min(0).describe('Line number (0-indexed)'),
      character: z.number().int().min(0).describe('Character position (0-indexed)'),
    },
    async ({ filePath, line, character }) => {
      const hovers = await bridge.getHover(filePath, line, character)
      const contents = (hovers ?? []).flatMap(h => {
        const c = h.contents
        if (Array.isArray(c)) {
          return c.map(item => (typeof item === 'string' ? item : (item as { value: string }).value))
        }
        return [typeof c === 'string' ? c : (c as { value: string }).value]
      })
      return { content: [{ type: 'text', text: JSON.stringify({ contents }) }] }
    }
  )

  // --- Get Document Symbols ---
  server.tool(
    'get_document_symbols',
    'Get all symbols (functions, classes, variables, etc.) in a file',
    {
      filePath: z.string().describe('Absolute path to the file'),
    },
    async ({ filePath }) => {
      const symbols = await bridge.getDocumentSymbols(filePath)
      const serialized = serializeSymbols((symbols ?? []) as Parameters<typeof serializeSymbols>[0])
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Search Workspace Symbols ---
  server.tool(
    'search_workspace_symbols',
    'Search for symbols across the entire workspace',
    {
      query: z.string().describe('Symbol name to search for'),
    },
    async ({ query }) => {
      const symbols = await bridge.getWorkspaceSymbols(query)
      const serialized = (symbols ?? []).map(s => ({
        name: s.name,
        kind: symbolKindName(s.kind),
        filePath: s.location.uri.fsPath,
        startLine: s.location.range.start.line,
        containerName: s.containerName ?? null,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Get Code Actions ---
  server.tool(
    'get_code_actions',
    'Get available code actions (quick fixes, refactors) for a range in a file',
    {
      filePath: z.string().describe('Absolute path to the file'),
      startLine: z.number().int().min(0),
      startChar: z.number().int().min(0),
      endLine: z.number().int().min(0),
      endChar: z.number().int().min(0),
    },
    async ({ filePath, startLine, startChar, endLine, endChar }) => {
      const actions = await bridge.getCodeActions(filePath, startLine, startChar, endLine, endChar)
      type AnyAction = { title: string; kind?: { value: string }; isPreferred?: boolean }
      const serialized = (actions ?? []).map((a, i) => {
        const action = a as AnyAction
        return {
          index: i,
          title: action.title,
          kind: action.kind?.value ?? null,
          isPreferred: action.isPreferred ?? false,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Apply Code Action ---
  server.tool(
    'apply_code_action',
    'Apply a code action by index (get index from get_code_actions first)',
    {
      filePath: z.string(),
      startLine: z.number().int().min(0),
      startChar: z.number().int().min(0),
      endLine: z.number().int().min(0),
      endChar: z.number().int().min(0),
      actionIndex: z.number().int().min(0).describe('Index from get_code_actions result'),
    },
    async ({ filePath, startLine, startChar, endLine, endChar, actionIndex }) => {
      const actions = await bridge.getCodeActions(filePath, startLine, startChar, endLine, endChar)
      const action = (actions ?? [])[actionIndex]
      if (!action) throw new Error(`No code action at index ${actionIndex}`)

      let applied = false
      if ('edit' in action && action.edit) {
        await import('vscode').then(vscode => vscode.workspace.applyEdit(action.edit!))
        applied = true
      } else if ('command' in action && action.command) {
        const cmd = typeof action.command === 'string' ? action.command : action.command.command
        await import('vscode').then(vscode => vscode.commands.executeCommand(cmd))
        applied = true
      }

      return { content: [{ type: 'text', text: JSON.stringify({ applied, title: 'title' in action ? action.title : '' }) }] }
    }
  )

  // --- Rename Symbol ---
  server.tool(
    'rename_symbol',
    'Rename a symbol and all its references across the workspace',
    {
      filePath: z.string().describe('Absolute path to the file'),
      line: z.number().int().min(0).describe('Line number (0-indexed)'),
      character: z.number().int().min(0).describe('Character position (0-indexed)'),
      newName: z.string().describe('The new name for the symbol'),
    },
    async ({ filePath, line, character, newName }) => {
      const edit = await bridge.getRenameEdits(filePath, line, character, newName)
      if (!edit) throw new Error('Rename not supported at this position')
      const vscode = await import('vscode')
      await vscode.workspace.applyEdit(edit)
      const filesChanged = new Set(edit.entries().map(([uri]) => uri.fsPath)).size
      const editsApplied = edit.entries().reduce((sum, [, edits]) => sum + edits.length, 0)
      return { content: [{ type: 'text', text: JSON.stringify({ filesChanged, editsApplied }) }] }
    }
  )

  // --- Workspace Info ---
  server.tool('get_workspace_info', 'Get information about the current VS Code workspace', {}, async () => {
    const info = bridge.getWorkspaceInfo()
    return { content: [{ type: 'text', text: JSON.stringify(info) }] }
  })

  // --- Git Status ---
  server.tool('get_git_status', 'Get the current git status (branch, staged/unstaged changes)', {}, async () => {
    const status = await bridge.getGitStatus()
    return { content: [{ type: 'text', text: JSON.stringify(status) }] }
  })

  // --- Git Diff ---
  server.tool(
    'get_git_diff',
    'Get the git diff for a file or the entire repo',
    {
      filePath: z.string().optional().describe('Absolute path to a specific file, or omit for all changes'),
      staged: z.boolean().optional().default(false).describe('Get staged (index) diff instead of working tree diff'),
    },
    async ({ filePath, staged }) => {
      const diff = await bridge.getGitDiff(filePath, staged)
      return { content: [{ type: 'text', text: JSON.stringify({ diff }) }] }
    }
  )

  // --- Execute VS Code Command ---
  server.tool(
    'execute_vscode_command',
    'Execute any VS Code command. Requires the command to be in the allowedCommands setting.',
    {
      command: z.string().describe('The VS Code command ID to execute'),
      args: z.array(z.unknown()).optional().default([]).describe('Arguments to pass to the command'),
    },
    async ({ command, args }) => {
      const allowedCommands = settings.get<Array<string>>('allowedCommands') ?? []
      const result = await bridge.executeCommand(command, args as Array<unknown>, allowedCommands)
      return { content: [{ type: 'text', text: JSON.stringify({ result }) }] }
    }
  )
}
