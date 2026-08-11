import { build, context } from 'esbuild';
import { readFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  outdir: 'build/renderer', // outfile → outdir（splitting 硬性要求，已实测报错）
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  splitting: true, // 动态 import 拆 chunk（mermaid 懒加载等）
  entryNames: 'renderer', // 保持入口输出名 renderer.js（index.html:111 依赖）
  chunkNames: 'chunks/[name]-[hash]', // 动态 chunk 放 build/renderer/chunks/
  minify: !watch, // 生产压缩；watch 不压（提速）
  sourcemap: watch ? 'inline' : false, // 生产无 .map；watch 内联便于调试
  assetNames: 'assets/[name]-[hash]',
  loader: {
    '.woff2': 'file',
    '.png': 'file',
    '.svg': 'file',
  },
  plugins: [
    // KaTeX 只保留 woff2 @font-face：砍掉 woff/ttf 引用 → esbuild 只拷贝 20 个 woff2
    {
      name: 'katex-woff2-only',
      setup(build) {
        build.onLoad({ filter: /katex\.min\.css$/ }, async (args) => {
          const src = await readFile(args.path, 'utf8');
          const slim = src.replace(
            /,url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
            ''
          );
          return { contents: slim, loader: 'css' };
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching…');
} else {
  await build(options);
  console.log('[build] build/renderer/renderer.js written');
}
