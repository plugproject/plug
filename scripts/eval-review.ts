import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import {
  reviewerFromEnv,
  reviewCheckerFromEnv,
  reviewDesign,
} from '../packages/plug/src/review/index';
import { loadReviewEvalCases } from '../tests/review-eval/cases';

const argument = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const trials = Number(argument('--trials') ?? 1);
if (!Number.isInteger(trials) || trials < 1 || trials > 20)
  throw new Error('--trials must be an integer from 1 to 20');
const localEnv = resolve('.env.local');
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

const provider = reviewerFromEnv(process.env);
const checker = reviewCheckerFromEnv(process.env);
const cases = loadReviewEvalCases();
const directory = resolve('.plug/evals');
await mkdir(directory, { recursive: true });
const id = new Date().toISOString().replaceAll(/[:.]/g, '-');
const file = join(directory, `review-${id}.jsonl`);
const rows: {
  caseId: string;
  trial: number;
  pass: boolean;
  engineAgreement: boolean;
  abstained: boolean;
  unsettled: number;
  dropped: number;
  criticDisagreed: boolean;
  jevInputTokens: number;
  jevCostUsd: number;
}[] = [];

for (const testCase of cases)
  for (let trial = 1; trial <= trials; trial++) {
    const design = suggestDesign(testCase.input);
    const started = performance.now();
    const result = await reviewDesign(
      testCase.input,
      design,
      design.connections[0].connectionId,
      provider,
      checker,
      { operationalContext: testCase.operationalContext },
    );
    const recommendation = result.decision.recommendation;
    const pass =
      testCase.expectedAdoptable.length === 0
        ? recommendation === null
        : recommendation !== null &&
          testCase.expectedAdoptable.includes(recommendation);
    const jevInputTokens = result.judgments?.usage.input_tokens ?? 0;
    const row = {
      caseId: testCase.id,
      trial,
      pass,
      engineAgreement: recommendation === testCase.expectedEngine,
      abstained: recommendation === null,
      unsettled: result.decision.unsettledConcerns.length,
      dropped: result.critique.droppedClaims,
      criticDisagreed:
        result.critique.preferred !== null &&
        result.critique.preferred.architectureId !== recommendation,
      jevInputTokens,
      // TypeSafe Jev input price at implementation time; this is an estimate,
      // not an invoice. Provider-side critic cost is unavailable here.
      jevCostUsd: (jevInputTokens * 0.042) / 1_000_000,
    };
    rows.push(row);
    await appendFile(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        evaluation: 'design-review',
        label: 'Review-layer evaluation; not a production measurement or SLO.',
        expectedEngine: testCase.expectedEngine,
        expectedAdoptable: testCase.expectedAdoptable,
        wallMs: Number((performance.now() - started).toFixed(1)),
        ...row,
        result,
      }) + '\n',
    );
  }

const fraction = (values: boolean[]) =>
  values.length
    ? Number((values.filter(Boolean).length / values.length).toFixed(4))
    : 0;
const passAtK = fraction(
  cases.map((testCase) =>
    rows.filter((row) => row.caseId === testCase.id).some((row) => row.pass),
  ),
);
const report = {
  trials: rows.length,
  cases: cases.length,
  passAt1: fraction(rows.map((row) => row.pass)),
  passAtK,
  engineAgreement: fraction(rows.map((row) => row.engineAgreement)),
  abstentionRate: fraction(rows.map((row) => row.abstained)),
  criticDisagreementRate: fraction(rows.map((row) => row.criticDisagreed)),
  unsettledConcerns: rows.reduce((sum, row) => sum + row.unsettled, 0),
  droppedClaims: rows.reduce((sum, row) => sum + row.dropped, 0),
  jevInputTokens: rows.reduce((sum, row) => sum + row.jevInputTokens, 0),
  estimatedJevCostUsd: Number(
    rows.reduce((sum, row) => sum + row.jevCostUsd, 0).toFixed(8),
  ),
  criticCost: 'unknown (completion provider usage is not exposed)',
  record: file,
  label: 'Review-layer evaluation; not a production measurement or SLO.',
};
console.log(JSON.stringify(report, null, 2));
