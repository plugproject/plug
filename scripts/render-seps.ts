import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const name of readdirSync('seps')
  .filter((n) => /^\d{4}-.+\.md$/.test(n))
  .sort()) {
  const source = readFileSync(`seps/${name}`, 'utf8');
  writeFileSync(
    `docs/seps/${name.replace('.md', '.mdx')}`,
    source.replace(
      /\]\(\.\.\/tests\//g,
      '](https://github.com/plugproject/plug/blob/main/tests/',
    ),
  );
}
