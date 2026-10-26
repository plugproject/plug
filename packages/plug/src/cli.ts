#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectionById,
  executeProbe,
  explainDesign,
  flightInput,
  parseInput,
  runDemo,
  selectedOperation,
  startFixture,
  suggestDesign,
  validateInput,
  verifyEdge,
} from './index';
import {
  inspectWorkspaceEnvironment,
  promptForPlugEnvironment,
} from './environment';
import { indexWorkspace } from './indexer/index';
import { installMcp, runMcpServer } from './mcp/server';
import type { McpIde } from './mcp/server';
import {
  readSpecBundle,
  specDir,
  specFiles,
  writeSpecBundle,
} from './openspec/bundle';
import { installSkill } from './skill/install';
import type { SkillIde } from './skill/install';
import { startUiServer } from './ui/server';
const [command, file, ...args] = process.argv.slice(2);
const option = (name: string, rest = args) => {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  if (!rest[i + 1] || rest[i + 1].startsWith('--'))
    throw new Error(`${name} requires a value`);
  return rest[i + 1];
};
const usage =
  'Usage: plug analyze|explain|demo input.json [--out directory] [--connection ID] [--endpoint http://127.0.0.1:PORT/search] [--pattern ID]\n       plug setup [--check] [--workspace directory]\n       plug index [directory] [--out file]\n       plug probe [systemId] [--operation ID] [--workspace directory]\n       plug verify [connectionId] [--mode as-is|design] [--workspace directory]\n       plug ui [--port N] [--workspace directory]\n       plug spec [input.json|workflow.yaml] [--dir directory]\n       plug mcp [--workspace directory]\n       plug mcp install [--ide cursor|vscode|claude|generic] [--workspace directory]\n       plug skill install [--ide cursor|vscode|claude|generic] [--workspace directory]';
const loadWorkspaceEnvironment = (workspace: string) => {
  const localEnv = join(workspace, '.env.local');
  if (existsSync(localEnv)) process.loadEnvFile(localEnv);
};
async function setup() {
  const rest = [file, ...args].filter((value): value is string => !!value);
  const workspace = resolve(option('--workspace', rest) ?? '.');
  if (rest.includes('--check')) {
    console.log(
      JSON.stringify(
        inspectWorkspaceEnvironment(workspace, process.env),
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    'Plug core analysis needs no environment variables. This setup configures optional local model roles.',
  );
  const result = await promptForPlugEnvironment({ workspace });
  console.log(
    result.action === 'unchanged'
      ? `Environment unchanged; configuration status checked for ${workspace}.`
      : `${result.action === 'created' ? 'Created' : 'Updated'} ${result.file}.`,
  );
  if (result.written.length)
    console.log(`Configured: ${result.written.join(', ')}.`);
}
async function spec() {
  const rest = file?.startsWith('--') ? [file, ...args] : args;
  const source = file && !file.startsWith('--') ? file : undefined;
  const dir = option('--dir', rest) ?? '.';
  const from =
    source ??
    [specFiles.workflow, specFiles.input]
      .map((f) => join(specDir(dir), f))
      .find((f) => existsSync(f));
  if (!from || !existsSync(from))
    throw new Error(
      'No spec yet: pass a DesignInput or workflow document, e.g. plug spec input.json',
    );
  const written = await writeSpecBundle(
    dir,
    parseInput(readFileSync(from, 'utf8')),
  );
  for (const f of written.files) console.log(`Wrote ${f}`);
  for (const c of written.connections)
    console.log(
      `${c.connectionId}: ${c.caller} → ${c.downstream}: ${c.selectedArchitectureId ?? 'no feasible architecture yet'}`,
    );
  for (const g of written.gaps) console.log(`Gap: ${g}`);
}
async function index() {
  const rest = file?.startsWith('--') ? [file, ...args] : args;
  const dir = file && !file.startsWith('--') ? file : '.';
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    const result = await indexWorkspace(dir, { signal: controller.signal });
    const text = JSON.stringify(result, null, 2) + '\n';
    const out = option('--out', rest);
    if (out) writeFileSync(resolve(out), text);
    else process.stdout.write(text);
  } finally {
    process.removeListener('SIGINT', abort);
  }
}
async function probe() {
  const rest = [file, ...args].filter((value): value is string => !!value);
  const workspace = resolve(option('--workspace', rest) ?? '.');
  const systemId = file && !file.startsWith('--') ? file : undefined;
  const operationId = option('--operation', rest);
  loadWorkspaceEnvironment(workspace);
  const spec = await readSpecBundle(workspace);
  if (!spec.input)
    throw new Error(
      'No OpenSpec input exists. Write .plug/workflow.yaml before probing.',
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await executeProbe(spec.input, {
      workspace,
      systemId,
      operationId,
      signal: controller.signal,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(
      JSON.stringify({
        type: 'probe-summary',
        manifests: result.manifests.length,
        updatedConnectionIds: result.updatedConnectionIds,
        revisionId: result.revisionId,
      }),
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
async function verify() {
  const rest = [file, ...args].filter((value): value is string => !!value);
  const workspace = resolve(option('--workspace', rest) ?? '.');
  const connectionId =
    file && !file.startsWith('--') ? file : option('--connection', rest);
  if (!connectionId) throw new Error('plug verify requires a connection ID.');
  const mode = option('--mode', rest) ?? 'design';
  if (mode !== 'as-is' && mode !== 'design')
    throw new Error('--mode must be as-is or design.');
  loadWorkspaceEnvironment(workspace);
  const spec = await readSpecBundle(workspace);
  if (!spec.input)
    throw new Error(
      'No OpenSpec input exists. Write .plug/workflow.yaml before verification.',
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await verifyEdge(spec.input, connectionId, mode, {
      workspace,
      revisionId: spec.currentRevisionId,
      signal: controller.signal,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ type: 'verification', record: result }));
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
async function ui() {
  const rest = [file, ...args].filter((x) => x !== undefined);
  const portText = option('--port', rest);
  const port = portText === undefined ? undefined : Number(portText);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  )
    throw new Error('--port must be an integer from 0 to 65535');
  const workspaceDir = resolve(option('--workspace', rest) ?? '.');
  loadWorkspaceEnvironment(workspaceDir);
  const server = await startUiServer({
    port,
    workspaceDir,
  });
  console.log(
    `Plug workbench on ${server.url} (loopback only). Ctrl-C stops it.`,
  );
  const stop = () => void server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
async function mcp() {
  const rest = [file, ...args].filter((x) => x !== undefined);
  const workspace = resolve(option('--workspace', rest) ?? '.');
  if (file !== 'install') {
    loadWorkspaceEnvironment(workspace);
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    await runMcpServer(workspace, version);
    return;
  }
  const ide = option('--ide', rest) ?? 'cursor';
  if (!['cursor', 'vscode', 'claude', 'generic'].includes(ide))
    throw new Error('--ide must be cursor, vscode, claude or generic');
  const result = await installMcp(
    workspace,
    ide as McpIde,
    fileURLToPath(import.meta.url),
  );
  if (result.action === 'printed') {
    console.log(JSON.stringify(result.config, null, 2));
    return;
  }
  console.log(
    `${result.action === 'unchanged' ? 'Already registered in' : `Registered Plug (${result.action}) in`} ${result.file}. Reload MCP servers in your IDE; Plug exposes spec, probe, verify, review, adoption and revision tools.`,
  );
}
async function skill() {
  const rest = [file, ...args].filter((x) => x !== undefined);
  if (file !== 'install') throw new Error(usage);
  const workspace = resolve(option('--workspace', rest) ?? '.');
  const ide = option('--ide', rest) ?? 'cursor';
  if (!['cursor', 'vscode', 'claude', 'generic'].includes(ide))
    throw new Error('--ide must be cursor, vscode, claude or generic');
  const result = await installSkill(
    workspace,
    ide as SkillIde,
    fileURLToPath(new URL('../skill/plug', import.meta.url)),
  );
  console.log(
    `${result.action === 'unchanged' ? 'Plug skill already installed in' : `Plug skill ${result.action} in`} ${result.directory}.`,
  );
}
async function main() {
  if (command === 'setup') return setup();
  if (command === 'index') return index();
  if (command === 'probe') return probe();
  if (command === 'verify') return verify();
  if (command === 'ui') return ui();
  if (command === 'spec') return spec();
  if (command === 'mcp') return mcp();
  if (command === 'skill') return skill();
  if (!['analyze', 'explain', 'demo'].includes(command)) throw new Error(usage);
  const input =
    file && file !== 'flight'
      ? validateInput(parseInput(readFileSync(file, 'utf8')))
      : flightInput();
  const design = suggestDesign(input);
  const connectionId = option('--connection');
  const connection = connectionById(input, connectionId);
  const report = design.connections.find(
    (r) => r.connectionId === connection.id,
  )!;
  if (command === 'analyze' || command === 'explain') {
    console.log(
      command === 'analyze'
        ? JSON.stringify(design, null, 2)
        : explainDesign(design),
    );
    const out = option('--out');
    if (out) {
      const dir = resolve(out);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'design.json'),
        JSON.stringify(design, null, 2) + '\n',
      );
      writeFileSync(resolve(dir, 'design.md'), explainDesign(design));
      const candidate = report.candidates.find(
        (c) => c.id === report.selectedId,
      );
      if (candidate)
        writeFileSync(
          resolve(dir, 'runner.json'),
          JSON.stringify(
            {
              designHash: design.designHash,
              inputHash: design.inputHash,
              catalogHash: design.catalogHash,
              connectionId: connection.id,
              config: candidate.config,
            },
            null,
            2,
          ) + '\n',
        );
    }
    return;
  }
  const endpoint = args.includes('--endpoint') ? option('--endpoint') : null,
    pattern = option('--pattern');
  const candidate = report.candidates.find(
    (c) => c.id === (pattern ?? report.selectedId),
  );
  if (!candidate)
    throw new Error('Select an evaluated runnable pattern with --pattern');
  if (!endpoint && file && file !== 'flight')
    throw new Error(
      'Own input execution needs an explicit trusted --endpoint binding',
    );
  const op = selectedOperation(input, connection.id);
  if (!op.outputSchema || !op.inputSchema)
    throw new Error('Execution needs structured contracts');
  const fixture = endpoint ? null : await startFixture();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fixture?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  const runner = runDemo(candidate, {
    endpoint: fixture?.endpoint ?? endpoint!,
    inputSchema: op.inputSchema,
    outputSchema: op.outputSchema,
    onEvent: (e) => console.log(JSON.stringify(e)),
    onTerminal: () => {
      void cleanup();
    },
  });
  const stop = () => runner.stop('process-shutdown');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const key = connection.workload.prewarmKeys?.[0];
  if (key) {
    await runner.request(key, 'initial');
    setTimeout(() => {
      void runner.request(key, 'warm');
    }, 1000);
  }
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
