import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

const configs = [
  {
    entryPoints: ['src/extension/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode', 'node:sqlite'],
    sourcemap: true,
    minify: false,
  },
  {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    minify: false,
  },
  {
    entryPoints: ['src/webview/demoEntry.ts'],
    bundle: true,
    outfile: 'demo/bundle.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: false,
    minify: false,
  },
]

if (watch) {
  const ctxs = await Promise.all(configs.map(c => esbuild.context(c)))
  await Promise.all(ctxs.map(c => c.watch()))
  console.log('Watching...')
} else {
  await Promise.all(configs.map(c => esbuild.build(c)))
  console.log('Built extension, webview, and demo bundle.')
}
