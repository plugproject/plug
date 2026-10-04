import { readFileSync, writeFileSync } from 'node:fs';
const schema = JSON.parse(readFileSync('schema/draft/schema.json', 'utf8'));
const template = readFileSync('schema/draft/schema.mdx', 'utf8');
const body = Object.entries(schema.definitions as Record<string, any>)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([name, definition]) =>
      `## ${name}\n\n${definition.description ?? ''}\n\n\`\`\`json\n${JSON.stringify(definition, null, 2)}\n\`\`\`\n`,
  )
  .join('\n');
writeFileSync(
  'docs/specification/draft/schema.mdx',
  template.replace('<!-- GENERATED_REFERENCE -->', body),
);
