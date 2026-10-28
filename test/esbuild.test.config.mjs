import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const vscodeMock = path.join(testDir, 'vscode-mock.ts')

await esbuild.build({
  entryPoints: [
    path.join(testDir, 'command-authorization.test.ts'),
    path.join(testDir, 'smoke-authorization.ts'),
  ],
  bundle: true,
  outdir: path.join(testDir, '.build'),
  outExtension: { '.js': '.mjs' },
  external: ['@modelcontextprotocol/sdk/*', 'zod'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
  plugins: [
    {
      name: 'vscode-mock',
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeMock }))
      },
    },
  ],
})

console.log('Test bundles complete.')
