import { flightInput, keys } from '../../packages/plug/src/demo/flight';
import { runDemo } from '../../packages/plug/src/demo/runtime';
import { startFixture } from '../../packages/plug/src/demo/fixture';
import { suggestDesign } from '../../packages/plug/src/recommender/index';
const input = flightInput(),
  report = suggestDesign(input),
  fixture = await startFixture();
const runner = runDemo(
  report.candidates.find((c) => c.id === report.selectedId)!,
  {
    endpoint: fixture.endpoint,
    outputSchema: input.systems[1].operations[0].outputSchema!,
    onEvent: (e) => console.log(JSON.stringify(e)),
    onTerminal: () => {
      void fixture.close();
      clearInterval(requests);
    },
  },
);
const requests = setInterval(() => {
  void runner.request(keys[0]);
}, 22000);
process.once('SIGINT', () => runner.stop('process-shutdown'));
process.once('SIGTERM', () => runner.stop('process-shutdown'));
console.log(
  'Real 15-second source; requests every 22 seconds; 120-second bounded demonstration. Ctrl-C stops it.',
);
