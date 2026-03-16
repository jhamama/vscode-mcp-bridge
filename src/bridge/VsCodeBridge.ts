import * as vscode from 'vscode'
import * as path from 'path'
import type { GitExtension, Repository, Status } from '../types/git.js'

export interface ActiveFileSnapshot {
  path: string
  relativePath: string
  content: string
  language: string
  isDirty: boolean
  lineCount: number
}

export interface SelectionSnapshot {
  text: string
  startLine: number
  startChar: number
  endLine: number
  endChar: number
  isEmpty: boolean
  filePath: string
}

export interface OpenTab {
  path: string
  relativePath: string
  language: string
  isDirty: boolean
  isActive: boolean
}

export interface DiagnosticItem {
  filePath: string
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  source: string
  code: string | number | null
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export interface TerminalResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface GitStatus {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: Array<{ path: string; status: string }>
  unstaged: Array<{ path: string; status: string }>
  untracked: Array<string>
}

function statusToString(status: Status): string {
  const map: Record<number, string> = {
    0: 'INDEX_MODIFIED',
    1: 'INDEX_ADDED',
    2: 'INDEX_DELETED',
    3: 'INDEX_RENAMED',
    4: 'INDEX_COPIED',
    5: 'MODIFIED',
    6: 'DELETED',
    7: 'UNTRACKED',
    8: 'IGNORED',
    9: 'INTENT_TO_ADD',
  }
  return map[status as number] ?? 'UNKNOWN'
}

// In-memory file system provider for diff previews
class MemoryFileSystemProvider implements vscode.FileSystemProvider {
  private files = new Map<string, Uint8Array>()
  private _emitter = new vscode.EventEmitter<Array<vscode.FileChangeEvent>>()
  readonly onDidChangeFile = this._emitter.event

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined) }
  stat(uri: vscode.Uri): vscode.FileStat {
    const data = this.files.get(uri.path)
    if (!data) throw vscode.FileSystemError.FileNotFound(uri)
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.byteLength }
  }
  readDirectory(): Array<[string, vscode.FileType]> { return [] }
  createDirectory(): void { }
  readFile(uri: vscode.Uri): Uint8Array {
    const data = this.files.get(uri.path)
    if (!data) throw vscode.FileSystemError.FileNotFound(uri)
    return data
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    this.files.set(uri.path, content)
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
  }
  delete(uri: vscode.Uri): void { this.files.delete(uri.path) }
  rename(): void { }
}

export class VsCodeBridge {
  readonly memFs: MemoryFileSystemProvider

  constructor() {
    this.memFs = new MemoryFileSystemProvider()
  }

  // --- Active File ---

  getActiveFileSnapshot(): ActiveFileSnapshot | null {
    const editor = vscode.window.activeTextEditor
    if (!editor) return null
    return {
      path: editor.document.uri.fsPath,
      relativePath: vscode.workspace.asRelativePath(editor.document.uri),
      content: editor.document.getText(),
      language: editor.document.languageId,
      isDirty: editor.document.isDirty,
      lineCount: editor.document.lineCount,
    }
  }

  // --- Selection ---

  getSelectionSnapshot(): SelectionSnapshot | null {
    const editor = vscode.window.activeTextEditor
    if (!editor) return null
    const sel = editor.selection
    return {
      text: editor.document.getText(sel),
      startLine: sel.start.line,
      startChar: sel.start.character,
      endLine: sel.end.line,
      endChar: sel.end.character,
      isEmpty: sel.isEmpty,
      filePath: editor.document.uri.fsPath,
    }
  }

  // --- Open Tabs ---

  getOpenTabs(): Array<OpenTab> {
    const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath
    const tabs: Array<OpenTab> = []

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri
          if (uri.scheme !== 'file') continue
          const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath)
          tabs.push({
            path: uri.fsPath,
            relativePath: vscode.workspace.asRelativePath(uri),
            language: doc?.languageId ?? path.extname(uri.fsPath).slice(1),
            isDirty: doc?.isDirty ?? tab.isDirty,
            isActive: uri.fsPath === activeUri,
          })
        }
      }
    }
    return tabs
  }

  // --- Diagnostics ---

  getDiagnostics(filePath?: string): Array<DiagnosticItem> {
    const severityMap: Record<number, DiagnosticItem['severity']> = {
      [vscode.DiagnosticSeverity.Error]: 'error',
      [vscode.DiagnosticSeverity.Warning]: 'warning',
      [vscode.DiagnosticSeverity.Information]: 'information',
      [vscode.DiagnosticSeverity.Hint]: 'hint',
    }

    const allDiags = filePath
      ? [[vscode.Uri.file(filePath), vscode.languages.getDiagnostics(vscode.Uri.file(filePath))] as [vscode.Uri, Array<vscode.Diagnostic>]]
      : vscode.languages.getDiagnostics()

    const results: Array<DiagnosticItem> = []
    for (const [uri, diags] of allDiags) {
      if (uri.scheme !== 'file') continue
      for (const d of diags) {
        results.push({
          filePath: uri.fsPath,
          severity: severityMap[d.severity] ?? 'information',
          message: d.message,
          source: d.source ?? '',
          code: typeof d.code === 'object' ? String(d.code.value) : (d.code ?? null),
          startLine: d.range.start.line,
          startChar: d.range.start.character,
          endLine: d.range.end.line,
          endChar: d.range.end.character,
        })
      }
    }
    return results
  }

  // --- LSP Commands ---

  async getReferences(filePath: string, line: number, char: number, includeDeclaration: boolean) {
    const uri = vscode.Uri.file(filePath)
    const pos = new vscode.Position(line, char)
    return vscode.commands.executeCommand<Array<vscode.Location>>(
      'vscode.executeReferenceProvider', uri, pos, { includeDeclaration }
    )
  }

  async getDefinition(filePath: string, line: number, char: number) {
    const uri = vscode.Uri.file(filePath)
    const pos = new vscode.Position(line, char)
    return vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider', uri, pos
    )
  }

  async getHover(filePath: string, line: number, char: number) {
    const uri = vscode.Uri.file(filePath)
    const pos = new vscode.Position(line, char)
    return vscode.commands.executeCommand<Array<vscode.Hover>>(
      'vscode.executeHoverProvider', uri, pos
    )
  }

  async getCodeActions(filePath: string, startLine: number, startChar: number, endLine: number, endChar: number) {
    const uri = vscode.Uri.file(filePath)
    const range = new vscode.Range(startLine, startChar, endLine, endChar)
    return vscode.commands.executeCommand<Array<vscode.Command | vscode.CodeAction>>(
      'vscode.executeCodeActionProvider', uri, range
    )
  }

  async getRenameEdits(filePath: string, line: number, char: number, newName: string) {
    const uri = vscode.Uri.file(filePath)
    const pos = new vscode.Position(line, char)
    return vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider', uri, pos, newName
    )
  }

  async getDocumentSymbols(filePath: string) {
    const uri = vscode.Uri.file(filePath)
    return vscode.commands.executeCommand<Array<vscode.DocumentSymbol>>(
      'vscode.executeDocumentSymbolProvider', uri
    )
  }

  async getWorkspaceSymbols(query: string) {
    return vscode.commands.executeCommand<Array<vscode.SymbolInformation>>(
      'vscode.executeWorkspaceSymbolProvider', query
    )
  }

  // --- Diff Editor ---

  async showDiff(filePath: string, newContent: string, title?: string) {
    const originalUri = vscode.Uri.file(filePath)
    const previewUri = vscode.Uri.parse(`vscode-mcp-preview:${filePath}`)
    this.memFs.writeFile(previewUri, Buffer.from(newContent, 'utf-8'))
    const label = title ?? `Proposed: ${path.basename(filePath)}`
    await vscode.commands.executeCommand('vscode.diff', originalUri, previewUri, label, { preview: true })
  }

  // --- File Operations ---

  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<{ content: string; lineCount: number; language: string }> {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    let content = doc.getText()
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split('\n')
      const sl = startLine ?? 0
      const el = endLine !== undefined ? endLine + 1 : lines.length
      content = lines.slice(sl, el).join('\n')
    }
    return { content, lineCount: doc.lineCount, language: doc.languageId }
  }

  async writeFile(filePath: string, content: string, createIfMissing = true): Promise<{ bytesWritten: number; created: boolean }> {
    const uri = vscode.Uri.file(filePath)
    let created = false
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      if (!createIfMissing) throw new Error(`File not found: ${filePath}`)
      created = true
    }
    const edit = new vscode.WorkspaceEdit()
    if (created) {
      edit.createFile(uri, { overwrite: false })
    }
    edit.set(uri, [vscode.TextEdit.replace(
      created
        ? new vscode.Range(0, 0, 0, 0)
        : new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      content
    )])
    await vscode.workspace.applyEdit(edit)
    return { bytesWritten: Buffer.byteLength(content, 'utf-8'), created }
  }

  async createFile(filePath: string, content = ''): Promise<void> {
    const uri = vscode.Uri.file(filePath)
    const edit = new vscode.WorkspaceEdit()
    edit.createFile(uri, { overwrite: false, contents: Buffer.from(content, 'utf-8') })
    await vscode.workspace.applyEdit(edit)
  }

  async deleteFile(filePath: string, useTrash = true): Promise<void> {
    const uri = vscode.Uri.file(filePath)
    const edit = new vscode.WorkspaceEdit()
    edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false })
    await vscode.workspace.applyEdit(edit)
  }

  async openFile(filePath: string, line?: number, char?: number, preview = false): Promise<void> {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const opts: vscode.TextDocumentShowOptions = { preview }
    if (line !== undefined) {
      const pos = new vscode.Position(line, char ?? 0)
      opts.selection = new vscode.Range(pos, pos)
    }
    await vscode.window.showTextDocument(doc, opts)
  }

  // --- Terminal ---

  async runCommand(command: string, cwd?: string, timeoutMs = 30000, strategy = 'childProcess'): Promise<TerminalResult> {
    const workingDir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()

    if (strategy === 'shellIntegration') {
      return this.runViaShellIntegration(command, workingDir, timeoutMs)
    }
    return this.runViaChildProcess(command, workingDir, timeoutMs)
  }

  private runViaChildProcess(command: string, cwd: string, timeoutMs: number): Promise<TerminalResult> {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process') as typeof import('child_process')
      const proc = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: err?.code ?? 0,
        })
      })
      proc.on('error', reject)
    })
  }

  private runViaShellIntegration(command: string, cwd: string, timeoutMs: number): Promise<TerminalResult> {
    return new Promise((resolve, reject) => {
      const terminal = vscode.window.createTerminal({ name: 'MCP Agent', cwd })
      terminal.show()
      terminal.sendText(command)

      const timeout = setTimeout(() => {
        disposable.dispose()
        terminal.dispose()
        reject(new Error(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const disposable = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.terminal === terminal) {
          clearTimeout(timeout)
          disposable.dispose()
          resolve({ stdout: '', stderr: '', exitCode: e.exitCode ?? null })
        }
      })
    })
  }

  // --- Workspace ---

  getWorkspaceInfo() {
    const folders = vscode.workspace.workspaceFolders ?? []
    return {
      folders: folders.map(f => ({ name: f.name, path: f.uri.fsPath })),
      name: vscode.workspace.name ?? null,
      rootPath: folders[0]?.uri.fsPath ?? null,
    }
  }

  // --- Git ---

  private getGitRepo(): Repository | null {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')
    if (!ext?.isActive) return null
    const api = ext.exports.getAPI(1)
    return api.repositories[0] ?? null
  }

  async getGitStatus(): Promise<GitStatus | null> {
    const repo = this.getGitRepo()
    if (!repo) return null

    const state = repo.state
    const branch = state.HEAD?.name ?? 'unknown'
    const upstream = state.HEAD?.upstream ? `${state.HEAD.upstream.remote}/${state.HEAD.upstream.name}` : null
    const ahead = state.HEAD?.ahead ?? 0
    const behind = state.HEAD?.behind ?? 0

    const staged = state.indexChanges.map(c => ({
      path: vscode.workspace.asRelativePath(vscode.Uri.file(c.uri.fsPath)),
      status: statusToString(c.status),
    }))

    const unstaged = state.workingTreeChanges
      .filter(c => c.status !== 7 /* UNTRACKED */)
      .map(c => ({
        path: vscode.workspace.asRelativePath(vscode.Uri.file(c.uri.fsPath)),
        status: statusToString(c.status),
      }))

    const untracked = state.workingTreeChanges
      .filter(c => c.status === 7 /* UNTRACKED */)
      .map(c => vscode.workspace.asRelativePath(vscode.Uri.file(c.uri.fsPath)))

    return { branch, upstream, ahead, behind, staged, unstaged, untracked }
  }

  async getGitDiff(filePath?: string, staged = false): Promise<string> {
    const repo = this.getGitRepo()
    if (!repo) return ''

    if (filePath) {
      return staged
        ? repo.diffIndexWithHEAD(filePath)
        : repo.diffWithHEAD(filePath)
    }

    return repo.diff(staged)
  }

  // --- Execute VS Code Command ---

  async executeCommand(command: string, args: Array<unknown> = [], allowedCommands: Array<string> = []): Promise<unknown> {
    if (allowedCommands.length > 0 && !allowedCommands.includes(command)) {
      throw new Error(`Command '${command}' is not in the allowed commands list`)
    }
    return vscode.commands.executeCommand(command, ...args)
  }
}
