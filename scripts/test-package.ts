import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
const connection = input.connections[0];
connection.inputMapping = [
  { from: 'sku', to: 'sku' },
  { from: 'region', to: 'region' },
];
connection.outputMapping = [{ from: 'available', to: 'available' }];
connection.profile.latencyMs.value = 350;
connection.workload.prewarmKeys = [{ sku: 'PACKED-2', region: 'north' }];
for (const row of connection.workload.trace)
  row.key = connection.workload.prewarmKeys[0];
writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
const bin = join(dir, 'node_modules/@plugproject/plug/dist/cli.js');
const report = JSON.parse(
  execFileSync(
    process.execPath,
    [bin, 'analyze', 'input.json', '--out', 'report'],
    { cwd: dir, encoding: 'utf8' },
  ),
);
assert.equal(report.connections[0].selectedId, 'scheduled-cache');
assert.equal(report.connections[0].selectedArchitectureId, 'scheduled-cache');
const workspaceIndex = JSON.parse(
  execFileSync(process.execPath, [bin, 'index', '.'], {
    cwd: dir,
    encoding: 'utf8',
  }),
);
assert.equal(workspaceIndex.indexerVersion, 'indexer-1');
assert.ok(
  !JSON.stringify(workspaceIndex).includes('node_modules'),
  'indexer skips dependencies',
);
execFileSync(process.execPath, [bin, 'spec', 'input.json'], {
  cwd: dir,
  encoding: 'utf8',
});
const workflow = readFileSync(join(dir, '.plug/workflow.yaml'), 'utf8');
assert.ok(workflow.includes('dsl: 1.0.3'), 'plug spec writes the workflow');
assert.ok(
  readFileSync(join(dir, '.plug/AGENTS.md'), 'utf8').includes(
    'plug_update_spec',
  ),
);
execFileSync(process.execPath, [bin, 'mcp', 'install', '--ide', 'cursor'], {
  cwd: dir,
  encoding: 'utf8',
});
const cursorConfig = JSON.parse(
  readFileSync(join(dir, '.cursor/mcp.json'), 'utf8'),
);
assert.deepEqual(cursorConfig.mcpServers.plug.args.slice(0, 3), [
  '--no-install',
  'plug',
  'mcp',
]);
const mcp = new Client({ name: 'plug-package-test', version: '0.0.0' });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp', '--workspace', dir],
    cwd: dir,
    stderr: 'pipe',
  }),
);
try {
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'plug_analyze',
    'plug_explain',
    'plug_get_spec',
    'plug_index_workspace',
    'plug_update_spec',
  ]);
  const spec = await mcp.callTool({ name: 'plug_get_spec', arguments: {} });
  assert.ok(!spec.isError, 'packed MCP server reads the spec');
} finally {
  await mcp.close();
}
await new Promise<void>((resolveUi, reject) => {
  const child = spawn(process.execPath, [bin, 'ui', '--port', '0'], {
    cwd: dir,
  });
  let output = '';
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error('Packed workbench timeout ' + output));
  }, 10000);
  child.stderr.on('data', (c) => (output += c.toString()));
  child.stdout.on('data', async (chunk) => {
    output += chunk.toString();
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
    if (!url) return;
    try {
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes('<div id="root">'));
      const workspace = await fetch(`${url}/api/workspace`);
      assert.equal((await workspace.json()).indexed, false);
      const indexed = await fetch(`${url}/api/workspace/index`, {
        method: 'POST',
      });
      assert.equal((await indexed.json()).fresh, true);
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolveUi();
    } catch (e) {
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(e);
    }
  });
});
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
