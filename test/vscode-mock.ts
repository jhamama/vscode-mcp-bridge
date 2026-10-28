/**
 * Minimal stand-in for the external `vscode` module used by the real bridge and
 * tool handlers under test. Only the surface those modules touch at runtime is
 * implemented. Shapes mirror the public VS Code extension API so tests exercise
 * production code without a real VS Code host.
 *
 * Deliberately incomplete: APIs used only by paths these tests do not exercise
 * (for example WorkspaceEdit/TextEdit for write_file, show_diff, rename_symbol)
 * are absent. Bundling therefore warns about those unresolved mock exports; this
 * is a fixture limitation, not a test failure.
 */

export interface ExecuteCommandCall {
  command: string
  args: ReadonlyArray<unknown>
}

export const mockState: {
  config: Record<string, unknown>
  commandCalls: Array<ExecuteCommandCall>
  appliedEdits: Array<unknown>
  codeActions: Array<unknown>
} = {
  config: {},
  commandCalls: [],
  appliedEdits: [],
  codeActions: [],
}

export function resetMockState(): void {
  mockState.config = {}
  mockState.commandCalls = []
  mockState.appliedEdits = []
  mockState.codeActions = []
}

export function callsTo(command: string): Array<ExecuteCommandCall> {
  return mockState.commandCalls.filter(call => call.command === command)
}

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn()
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>()

  readonly event = (listener: (event: T) => void): Disposable => {
    this.listeners.add(listener)
    return new Disposable(() => this.listeners.delete(listener))
  }

  fire(event: T): void {
    for (const listener of this.listeners) listener(event)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath)
  }

  static parse(value: string): Uri {
    const separator = value.indexOf(':')
    return separator === -1 ? new Uri('file', value) : new Uri(value.slice(0, separator), value.slice(separator + 1))
  }

  get fsPath(): string {
    return this.path
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position
  readonly end: Position

  constructor(startLine: number, startChar: number, endLine: number, endChar: number)
  constructor(start: Position, end: Position)
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new Position(a, b)
      this.end = new Position(c ?? a, d ?? b)
    } else {
      this.start = a as Position
      this.end = b as Position
    }
  }
}

export class FileSystemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileSystemError'
  }

  static FileNotFound(uri?: Uri): FileSystemError {
    return new FileSystemError(`File not found: ${uri?.path ?? ''}`)
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 } as const
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export class TabInputTextDiff {
  constructor(readonly original: Uri, readonly modified: Uri) {}
}

export class CodeActionKind {
  private constructor(readonly value: string) {}

  static readonly Empty = new CodeActionKind('')
  static readonly QuickFix = new CodeActionKind('quickfix')
  static readonly Refactor = new CodeActionKind('refactor')
}

export const workspace = {
  workspaceFolders: [] as Array<{ name: string; uri: Uri }>,
  textDocuments: [] as Array<Record<string, unknown>>,

  getConfiguration(_section: string) {
    return {
      get<T>(key: string): T | undefined {
        return mockState.config[key] as T | undefined
      },
    }
  },

  onDidChangeConfiguration(_listener: () => void): Disposable {
    return new Disposable()
  },

  asRelativePath(value: string | Uri): string {
    return typeof value === 'string' ? value : value.fsPath
  },

  async applyEdit(edit: unknown): Promise<boolean> {
    mockState.appliedEdits.push(edit)
    return true
  },

  async openTextDocument(): Promise<never> {
    throw new Error('openTextDocument is not part of this test fixture')
  },

  registerFileSystemProvider(): Disposable {
    return new Disposable()
  },
}

export const commands = {
  async executeCommand<T>(command: string, ...args: Array<unknown>): Promise<T> {
    mockState.commandCalls.push({ command, args })
    if (command === 'vscode.executeCodeActionProvider') {
      return mockState.codeActions as T
    }
    return { command, arguments: args } as T
  },

  registerCommand(_command: string, _callback: (...args: Array<unknown>) => unknown): Disposable {
    return new Disposable()
  },
}

export const window = {
  activeTextEditor: undefined as unknown,
  tabGroups: { all: [] as Array<unknown> },
  createOutputChannel(_name: string) {
    return { appendLine: () => undefined, append: () => undefined, dispose: () => undefined }
  },
  onDidEndTerminalShellExecution(_listener: () => void): Disposable {
    return new Disposable()
  },
}

export const languages = {
  getDiagnostics(): Array<unknown> {
    return []
  },
}
