import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
for (const name of readdirSync('seps').filter((n) =>
  /^\d{4}-.+\.md$/.test(n),
)) {
  const text = readFileSync(`seps/${name}`, 'utf8'),
    front = text.match(/^---\n([\s\S]*?)\n---/);
  if (!front) throw new Error(`Missing SEP metadata: ${name}`);
  const meta = parse(front[1]);
  if (
    ![
      'draft',
      'in-review',
      'accepted',
      'final',
      'rejected',
      'withdrawn',
      'superseded',
      'dormant',
    ].includes(meta.status) ||
    !meta.title
  )
    throw new Error(`Invalid SEP metadata: ${name}`);
  for (const section of [
    'Motivation',
    'Specification',
    'Rationale',
    'Compatibility',
    'Alternatives',
    'Security implications',
    'Implementation',
    'Validation',
  ])
    if (!text.includes(`## ${section}`))
      throw new Error(`Missing ${section}: ${name}`);
  if (meta.status === 'final' && !text.includes('../tests/'))
    throw new Error('Final behavior SEP needs regression tests');
}
console.log('SEP metadata and sections valid');
