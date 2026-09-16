// 仅用于本地验证面交模块的并发正确性：esbuild 打包测试（解析 @ 别名）后用 node 执行。
import { build } from '../node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js';
import { fileURLToPath, URL } from 'node:url';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: [fileURLToPath(new URL('./meetup-race.test.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
});

const outPath = fileURLToPath(new URL('./.race-bundle.mjs', import.meta.url));
writeFileSync(outPath, result.outputFiles[0].text);
await import(new URL('./.race-bundle.mjs', import.meta.url).href);

