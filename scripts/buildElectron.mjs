import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist-electron');

async function buildElectronBundles() {
  await fs.rm(outDir, { recursive: true, force: true });

  const sharedOptions = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'info',
  };

  await Promise.all([
    build({
      ...sharedOptions,
      entryPoints: [path.join(rootDir, 'electron/main.ts')],
      outfile: path.join(outDir, 'main.cjs'),
    }),
    build({
      ...sharedOptions,
      entryPoints: [path.join(rootDir, 'electron/preload.ts')],
      outfile: path.join(outDir, 'preload.cjs'),
    }),
    build({
      ...sharedOptions,
      entryPoints: [path.join(rootDir, 'electron/worker/plcSyncWorker.ts')],
      outfile: path.join(outDir, 'worker/plcSyncWorker.cjs'),
    }),
  ]);
}

buildElectronBundles().catch((err) => {
  console.error(err);
  process.exit(1);
});
