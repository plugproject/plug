import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const paths: string[] = [];
function walk(dir: string) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(p);
    else if (/\.mdx?$/.test(p)) paths.push(p);
  }
}
walk('docs');
walk('seps');
for (const path of paths) {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.mdx') && !/^---\ntitle:/.test(text))
    throw new Error(`Missing title: ${path}`);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^https?:|^mailto:/.test(target)) continue;
    const local = target.startsWith('/')
      ? resolve('docs', target.slice(1))
      : resolve(dirname(path), target);
    if (![local, `${local}.mdx`, `${local}.md`].some(existsSync))
      throw new Error(`Broken link in ${path}: ${target}`);
  }
}
const config = JSON.parse(readFileSync('docs/docs.json', 'utf8'));
function pages(v: unknown): void {
  if (Array.isArray(v)) {
    v.forEach(pages);
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [key, value] of Object.entries(v)) {
    if (key === 'pages') {
      for (const page of value as string[])
        if (!existsSync(`docs/${page}.mdx`))
          throw new Error(`Navigation page missing: ${page}`);
    } else pages(value);
  }
}
pages(config);
console.log('Documentation titles, navigation and internal links valid');
