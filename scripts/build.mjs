import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const builds = [
  { entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18' },
  { entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp-server.js', platform: 'node', format: 'cjs', target: 'node18', banner: { js: '#!/usr/bin/env node' } },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome114' },
  { entryPoints: ['test/harness.ts'], outfile: 'dist/test/harness.js', platform: 'browser', format: 'iife', target: 'chrome114' },
  { entryPoints: ['test/mcp.test.ts'], outfile: 'dist/test/mcp.test.cjs', platform: 'node', format: 'cjs', target: 'node18' },
].map((o) => ({ bundle: true, logLevel: 'warning', legalComments: 'none', sourcemap: watch ? 'inline' : false, ...o }));

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log('built');
}
