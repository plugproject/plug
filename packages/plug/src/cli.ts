#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  explainDesign,
  flightInput,
  parseInput,
  runDemo,
  selectedOperation,
  startFixture,
  suggestDesign,
  validateInput,
} from './index';
const [command, file, ...args] = process.argv.slice(2);
async function main() {
  if (!['analyze', 'explain', 'demo'].includes(command))
    throw new Error(
      'Usage: plug analyze|explain|demo input.json [--out directory] [--endpoint http://127.0.0.1:PORT/search] [--pattern ID]',
    );
  const input =
    file && file !== 'flight'
      ? validateInput(parseInput(readFileSync(file, 'utf8')))
      : flightInput();
  const report = suggestDesign(input);
  if (command === 'analyze' || command === 'explain') {
    console.log(
      command === 'analyze'
        ? JSON.stringify(report, null, 2)
        : explainDesign(report),
    );
    const out = args.indexOf('--out');
    if (out >= 0) {
      if (!args[out + 1]) throw new Error('--out requires a directory');
      const dir = resolve(args[out + 1]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'design.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
      writeFileSync(resolve(dir, 'design.md'), explainDesign(report));
      const candidate = report.candidates.find(
        (c) => c.id === report.selectedId,
      );
      if (candidate)
        writeFileSync(
          resolve(dir, 'runner.json'),
          JSON.stringify(
            {
              designHash: report.designHash,
              inputHash: report.inputHash,
              catalogHash: report.catalogHash,
              config: candidate.config,
            },
            null,
            2,
          ) + '\n',
        );
    }
    return;
  }
  const endpointIndex = args.indexOf('--endpoint'),
    patternIndex = args.indexOf('--pattern');
  const candidate = report.candidates.find(
    (c) =>
      c.id === (patternIndex >= 0 ? args[patternIndex + 1] : report.selectedId),
  );
  if (!candidate)
    throw new Error('Select an evaluated runnable pattern with --pattern');
  const fixture = endpointIndex < 0 ? await startFixture() : null;
  if (!fixture && !args[endpointIndex + 1])
    throw new Error('--endpoint requires a URL');
  if (fixture && file && file !== 'flight') {
    await fixture.close();
    throw new Error(
      'Own input execution needs an explicit trusted --endpoint binding',
    );
  }
  const op = selectedOperation(input);
  if (!op.outputSchema || !op.inputSchema)
    throw new Error('Execution needs structured contracts');
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fixture?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  const runner = runDemo(candidate, {
    endpoint: fixture?.endpoint ?? args[endpointIndex + 1],
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
  const key = input.workload.prewarmKeys?.[0];
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
