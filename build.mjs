// Build the extension into dist/. No arguments needed; `node build.mjs --watch` rebuilds on change,
// `node build.mjs --zip` also writes release/chatsearch-<version>.zip.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');
const out = 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('extension', out, { recursive: true });
mkdirSync(`${out}/ort`, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `${out}/ort/${f}`);
}

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['chrome120'],
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'warning',
};

const builds = [
  { entryPoints: { sw: 'src/sw/index.ts', offscreen: 'src/offscreen/main.ts', 'embed-worker': 'src/offscreen/embed-worker.ts', 'data-worker': 'src/ui/data-worker.ts' }, format: 'esm', outdir: out },
  { entryPoints: { ui: 'src/ui/main.tsx' }, format: 'esm', splitting: true, outdir: out, chunkNames: 'chunks/[name]-[hash]' },
  { entryPoints: { hook: 'src/content/hook.ts', bridge: 'src/content/bridge.ts' }, format: 'iife', outdir: out },
  { entryPoints: { ui: 'src/ui/styles.css' }, outdir: out },
];

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
  console.log('watching… (reload the extension in chrome://extensions after changes)');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
  console.log(`built ${out}/ (v${version})`);
  if (zip) {
    mkdirSync('release', { recursive: true });
    // one top-level chatsearch/ folder, so every unzip tool produces the same folder to "Load unpacked"
    const stage = 'release/stage';
    rmSync(stage, { recursive: true, force: true });
    cpSync(out, `${stage}/chatsearch`, { recursive: true });
    for (const name of [`chatsearch-${version}.zip`, 'chatsearch.zip']) {
      if (existsSync(`release/${name}`)) rmSync(`release/${name}`);
      execSync(`cd ${stage} && zip -qr ../${name} chatsearch -x '*/.*'`);
      console.log(`wrote release/${name}`);
    }
    rmSync(stage, { recursive: true, force: true });
  }
}
