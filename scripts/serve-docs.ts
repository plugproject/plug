import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { marked } from 'marked';
import { parse } from 'yaml';
const root = resolve('docs');
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const config = JSON.parse(readFileSync(resolve(root, 'docs.json'), 'utf8'));
const pages = config.navigation.groups.flatMap(
  (g: { pages: string[] }) => g.pages,
) as string[];
createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const page =
    path === '/'
      ? 'introduction'
      : decodeURIComponent(path.slice(1)).replace(/\.mdx$/, '');
  const file = resolve(root, page + '.mdx');
  if (!file.startsWith(root + '/') || !existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const text = readFileSync(file, 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  const title = front ? parse(front[1]).title : page;
  const body = marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, ''));
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Plug docs</title><style>body{font:16px system-ui;max-width:1200px;margin:40px auto;display:flex;gap:40px;padding:20px}nav{min-width:220px}a{color:#436329}nav a{display:block;margin:10px}pre{background:#f1f4e8;padding:16px;border-radius:6px}code{font-size:13px}p,li{line-height:1.7}@media(max-width:700px){body{display:block}nav{max-height:180px;overflow:auto}}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}article{min-width:0}h1{color:#38552b}</style></head><body><nav><h1>Plug docs</h1>${pages.map((p) => `<a href="/${p}">${escape(p)}</a>`).join('')}</nav><article><h1>${escape(title)}</h1>${body}</article></body></html>`,
    );
}).listen(3333, '127.0.0.1', () =>
  console.log(
    'Local documentation preview: http://127.0.0.1:3333. Mintlify-compatible navigation in docs/docs.json.',
  ),
);
