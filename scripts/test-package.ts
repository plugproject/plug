import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'plug-packed-'));
const packed = JSON.parse(
  execFileSync(
    'npm',
    [
      'pack',
      '--workspace',
      '@plugproject/plug',
      '--pack-destination',
      dir,
      '--json',
    ],
    { encoding: 'utf8' },
  ),
);
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'plug-consumer-test', private: true, type: 'module' }),
);
execFileSync(
  'npm',
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(dir, packed[0].filename),
  ],
  { cwd: dir, stdio: 'inherit' },
);
const input = JSON.parse(
  readFileSync('examples/your-http-api/input.json', 'utf8'),
);
// Change contract, field mappings, exact key, operational profile and binding outside the repo.
for (const s of input.systems) {
  s.name += ' customized';
  const op = s.operations[0];
  op.inputSchema.properties.region = op.inputSchema.properties.warehouse;
  delete op.inputSchema.properties.warehouse;
  op.inputSchema.required = ['sku', 'region'];
  op.semantics.keyDimensions = ['sku', 'region'];
  op.outputSchema = {
    type: 'object',
    properties: { available: { type: 'number' } },
    required: ['available'],
    additionalProperties: false,
  };
}
input.connection.inputMapping = [
  { from: 'sku', to: 'sku' },
  { from: 'region', to: 'region' },
];
input.connection.outputMapping = [{ from: 'available', to: 'available' }];
input.profile.latencyMs.value = 350;
input.workload.prewarmKeys = [{ sku: 'PACKED-2', region: 'north' }];
for (const row of input.workload.trace) row.key = input.workload.prewarmKeys[0];
writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
const bin = join(dir, 'node_modules/@plugproject/plug/dist/cli.js');
const report = JSON.parse(
  execFileSync(
    process.execPath,
    [bin, 'analyze', 'input.json', '--out', 'report'],
    { cwd: dir, encoding: 'utf8' },
  ),
);
assert.equal(report.selectedId, 'scheduled-cache');
assert.ok(
  readFileSync(
    join(dir, 'node_modules/@plugproject/plug/dist/schema.json'),
    'utf8',
  ).includes('DesignInput'),
);
writeFileSync(
  join(dir, 'consumer.ts'),
  "import { suggestDesign, type DesignInput } from '@plugproject/plug'; declare const input: DesignInput; const hash: string = suggestDesign(input).designHash; console.log(hash);\n",
);
execFileSync(
  process.execPath,
  [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--module',
    'nodenext',
    '--target',
    'es2022',
    '--skipLibCheck',
    join(dir, 'consumer.ts'),
  ],
  { cwd: dir, stdio: 'inherit' },
);
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const key = JSON.parse(body);
    assert.equal(key.region, 'north');
    const snapshotAt = Date.now();
    const t = setTimeout(
      () =>
        res
          .setHeader('Content-Type', 'application/json')
          .end(
            JSON.stringify({ snapshotAt, version: 7, data: { available: 23 } }),
          ),
      300,
    );
    res.on('close', () => clearTimeout(t));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
try {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [
        bin,
        'demo',
        'input.json',
        '--endpoint',
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom`,
      ],
      { cwd: dir },
    );
    let output = '',
      errors = '',
      success = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Packed runner timeout ' + errors));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (
        output.includes('"type":"cache-hit"') &&
        output.includes('"available":23')
      ) {
        success = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (c) => (errors += c.toString()));
    child.on('exit', () => {
      clearTimeout(timer);
      if (success) resolveRun();
      else reject(new Error('Packed runner failed: ' + errors + '\n' + output));
    });
  });
  console.log(
    'Packed package customized and executed successfully outside workspace:',
    dir,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
