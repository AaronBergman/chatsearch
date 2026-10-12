// Bundle each test/unit/*.test.ts with esbuild and run it with node:test.
import * as esbuild from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('test/unit').filter((f) => f.endsWith('.test.ts'));
mkdirSync('test/.out', { recursive: true });
await esbuild.build({ entryPoints: files.map((f) => `test/unit/${f}`), outdir: 'test/.out', bundle: true, platform: 'node', format: 'esm', target: 'node22', outExtension: { '.js': '.mjs' }, packages: 'external', logLevel: 'warning' });
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map((f) => `test/.out/${f.replace('.ts', '.mjs')}`)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
