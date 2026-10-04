import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = [
  'schema/draft/schema.json',
  'schema/draft/validators.js',
  'schema/draft/validators.d.ts',
  'docs/specification/draft/schema.mdx',
  ...readdirSync('seps')
    .filter((n) => /^\d{4}-.+\.md$/.test(n))
    .map((n) => `docs/seps/${n.replace('.md', '.mdx')}`),
];
const before = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
for (const script of ['generate-schemas', 'render-schema-docs', 'render-seps'])
  execFileSync(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`], {
    stdio: 'inherit',
  });
for (const [file, text] of before)
  if (readFileSync(file, 'utf8') !== text)
    throw new Error(
      `Generated artifact drift: ${file}. Commit npm run generate output.`,
    );
console.log('Generated artifacts are synchronized');
