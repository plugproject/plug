import { suggestDesign } from '../packages/plug/src/recommender/index';
import { flightInput } from '../packages/plug/src/demo/flight';
import { readdirSync, readFileSync } from 'node:fs';
import {
  assertContract,
  validateInput,
} from '../packages/plug/src/contracts/index';
for (const root of readdirSync('schema/draft/examples'))
  for (const name of readdirSync(`schema/draft/examples/${root}`)) {
    const data = JSON.parse(
      readFileSync(`schema/draft/examples/${root}/${name}`, 'utf8'),
    );
    assertContract(root, data);
    if (root === 'DesignInput') validateInput(data);
  }
for (const path of [
  'examples/flight-search/input.json',
  'examples/your-http-api/input.json',
])
  validateInput(JSON.parse(readFileSync(path, 'utf8')));
console.log('Schema and runnable example contracts valid');

const report = JSON.parse(
  readFileSync(
    'schema/draft/examples/DesignRecommendation/flight.json',
    'utf8',
  ),
);
if (report.designHash !== suggestDesign(flightInput()).designHash)
  throw new Error(
    'Flight recommendation example is stale: run tsx scripts/write-examples.ts and format',
  );
