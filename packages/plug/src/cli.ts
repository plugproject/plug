#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectionById,
  explainDesign,
  flightInput,
  parseInput,
  runDemo,
  selectedOperation,
  startFixture,
  suggestDesign,
  validateInput,
} from './index';
import { indexWorkspace } from './indexer/index';
import { installMcp, runMcpServer } from './mcp/server';
import type { McpIde } from './mcp/server';
import { specDir, specFiles, writeSpecBundle } from './openspec/bundle';
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
  'Usage: plug analyze|explain|demo input.json [--out directory] [--connection ID] [--endpoint http://127.0.0.1:PORT/search] [--pattern ID]\n       plug index [directory] [--out file]\n       plug ui [--port N] [--workspace directory]\n       plug spec [input.json|workflow.yaml] [--dir directory]\n       plug mcp [--workspace directory]\n       plug mcp install [--ide cursor|vscode|claude|generic] [--workspace directory]';
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
async function ui() {
  const rest = [file, ...args].filter((x) => x !== undefined);
  const portText = option('--port', rest);
  const port = portText === undefined ? undefined : Number(portText);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  )
    throw new Error('--port must be an integer from 0 to 65535');
  const server = await startUiServer({
    port,
    workspaceDir: option('--workspace', rest),
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
    `${result.action === 'unchanged' ? 'Already registered in' : `Registered Plug (${result.action}) in`} ${result.file}. Reload MCP servers in your IDE; tools: plug_get_spec, plug_update_spec, plug_analyze, plug_index_workspace, plug_explain.`,
  );
}
async function main() {
  if (command === 'index') return index();
  if (command === 'ui') return ui();
  if (command === 'spec') return spec();
  if (command === 'mcp') return mcp();
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
