// Builds the extension (dist/extension, load it unpacked) and the bridge (dist/bridge/cli.mjs).
// --test builds the same code into dist-test/ with the bridge port range moved up by 100, so the
// e2e tests never meet the extension in the user's own Chrome or the user's running bridges.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderIcon } from './icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const testBuild = process.argv.includes('--test');
const outDir = path.join(root, testBuild ? 'dist-test' : 'dist');
const extOut = path.join(outDir, 'extension');
const bridgeOut = path.join(outDir, 'bridge');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(extOut, 'icons'), { recursive: true });

/** Test build only: shifts PORT_BASE in src/shared/constants.ts (and fails loudly if that line ever changes). */
const testPorts = {
  name: 'test-ports',
  setup(b) {
    b.onLoad({ filter: /[\\/]shared[\\/]constants\.ts$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8');
      const shifted = code.replace(/export const PORT_BASE = (\d+);/, (_m, n) => `export const PORT_BASE = ${Number(n) + 100};`);
      if (shifted === code) throw new Error('test build: PORT_BASE not found in constants.ts');
      return { contents: shifted, loader: 'ts' };
    });
  },
};
const plugins = testBuild ? [testPorts] : [];

const common = { bundle: true, sourcemap: 'linked', target: 'chrome125', logLevel: 'warning', legalComments: 'none', plugins };

await Promise.all([
  build({ ...common, entryPoints: { background: path.join(src, 'extension/background/index.ts') }, format: 'esm', outdir: extOut }),
  build({ ...common, entryPoints: { overlay: path.join(src, 'extension/content/overlay.ts') }, format: 'iife', outdir: extOut }),
  build({
    ...common,
    entryPoints: {
      sidepanel: path.join(src, 'extension/sidepanel/sidepanel.ts'),
      devtools: path.join(src, 'extension/devtools/devtools.ts'),
      panel: path.join(src, 'extension/devtools/panel.ts'),
      offscreen: path.join(src, 'extension/offscreen/offscreen.ts'),
    },
    format: 'esm',
    outdir: extOut,
  }),
  build({
    entryPoints: { cli: path.join(src, 'bridge/cli.ts') },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: bridgeOut,
    outExtension: { '.js': '.mjs' },
    packages: 'external',
    sourcemap: 'linked',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
    plugins,
  }),
]);

const manifest = JSON.parse(await readFile(path.join(src, 'extension/manifest.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(path.join(extOut, 'manifest.json'), JSON.stringify(manifest, null, 2));
await cp(path.join(src, 'extension/_locales'), path.join(extOut, '_locales'), { recursive: true });
for (const file of ['sidepanel/sidepanel.html', 'sidepanel/sidepanel.css', 'devtools/devtools.html', 'devtools/panel.html', 'devtools/panel.css', 'offscreen/offscreen.html']) {
  await cp(path.join(src, 'extension', file), path.join(extOut, path.basename(file))).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
for (const size of [16, 32, 48, 128]) await writeFile(path.join(extOut, 'icons', `icon${size}.png`), renderIcon(size));

const rel = path.relative(root, outDir);
console.log(`built kyte-webmcp ${pkg.version}${testBuild ? ' (test ports)' : ''}: ${rel}/extension (load unpacked) + ${rel}/bridge/cli.mjs`);
