import * as vscode from 'vscode'

export class Settings {
  get<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration('mcpServer').get<T>(key)
  }

  get port(): number {
    return this.get<number>('port') ?? 3333
  }

  get enableContextPush(): boolean {
    return this.get<boolean>('enableContextPush') ?? true
  }

  get authToken(): string {
    return this.get<string>('authToken') ?? ''
  }

  onChange(cb: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mcpServer')) cb()
    })
  }
}
