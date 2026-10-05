import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  suggestDesign,
  validateInput,
  runDemo,
  selectedOperation,
} from '../../packages/plug/src/index';
const input = validateInput(
  JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8')),
);
const report = suggestDesign(input).connections[0],
  candidate = report.candidates.find((c) => c.id === report.selectedId);
if (!candidate) throw new Error('No feasible local design');
const server = createServer((req, res) => {
  if (req.url !== '/inventory' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const snapshotAt = Date.now();
  const timer = setTimeout(
    () =>
      res.setHeader('Content-Type', 'application/json').end(
        JSON.stringify({
          snapshotAt,
          version: 1,
          data: { stock: 42, warehouse: 'south' },
        }),
      ),
    250,
  );
  res.on('close', () => clearTimeout(timer));
});
await new Promise<void>((resolve) => server.listen(4010, '127.0.0.1', resolve));
// This trusted local service owns the scheduler until process shutdown.
const runner = runDemo(candidate, {
  endpoint: 'http://127.0.0.1:4010/inventory',
  outputSchema: selectedOperation(input).outputSchema!,
  inputSchema: selectedOperation(input).inputSchema!,
  lifetimeMs: null,
  onEvent: (e) => console.log(JSON.stringify(e)),
});
const requests = setInterval(() => {
  void runner?.request(input.connections[0].workload.prewarmKeys![0]);
}, 2000);
function stop() {
  clearInterval(requests);
  runner?.stop('process-shutdown');
  server.close();
  server.closeAllConnections();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log(
  'Custom inventory source and local scheduler stay running until Ctrl-C; process restarts begin cold.',
);
