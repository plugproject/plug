import { build } from 'esbuild';
import {
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
await build({
  entryPoints: ['packages/plug/src/index.ts', 'packages/plug/src/cli.ts'],
  outdir: 'packages/plug/dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});
execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--project',
    'packages/plug/tsconfig.build.json',
  ],
  { stdio: 'inherit' },
);
function fixDeclarations(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) fixDeclarations(path);
    else if (path.endsWith('.d.ts'))
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          /(from\s+['"])(\.[^'"]+)(['"])/g,
          (_match, before, target, after) => before + target + '.js' + after,
        ),
      );
  }
}
fixDeclarations('packages/plug/dist/types');
writeFileSync(
  'packages/plug/dist/index.d.ts',
  "export * from './types/packages/plug/src/index.js';\n",
);
copyFileSync('schema/draft/schema.json', 'packages/plug/dist/schema.json');
copyFileSync('LICENSE', 'packages/plug/LICENSE');
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['apps/playground/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
});
