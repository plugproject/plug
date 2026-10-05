import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parse } from 'yaml';
import { assertContract, guardDocument } from '../contracts/index';
import type {
  Evidence,
  Interface,
  JsonObject,
  Operation,
  Semantics,
  SystemDescription,
  WorkspaceFinding,
  WorkspaceIndex,
} from '../contracts/index';
import { importA2a } from '../importers/index';
export const indexerVersion = 'indexer-1';
export const indexLimits = {
  files: 2000,
  fileBytes: 512 * 1024,
  totalBytes: 16 * 1024 * 1024,
  depth: 16,
  findings: 500,
  hosts: 20,
};
export interface IndexOptions {
  signal?: AbortSignal;
  now?: () => Date;
  limits?: Partial<typeof indexLimits>;
}
const skippedDirectories = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.plug',
  '.turbo',
  '.cache',
  'test',
  'tests',
  '__tests__',
  'spec',
  'fixtures',
  '__fixtures__',
  'test-results',
  'playwright-report',
]);
const testFile = /\.(test|spec)\.[a-z]+$/i;
const secretFile =
  /^\.env(\..*)?$|\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^\.npmrc$|^\.netrc$/i;
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.rs',
  '.cs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
]);
const sourceExtensions = new Set(
  [...textExtensions].filter(
    (e) => !['.json', '.yaml', '.yml', '.toml'].includes(e),
  ),
);
const dependencyMarkers: {
  kind: WorkspaceFinding['kind'];
  detail: string;
  names: string[];
}[] = [
  {
    kind: 'interface',
    detail: 'HTTP server framework dependency',
    names: [
      'express',
      'fastify',
      'koa',
      'hono',
      '@nestjs/core',
      'flask',
      'fastapi',
    ],
  },
  {
    kind: 'interface',
    detail: 'HTTP client dependency',
    names: ['axios', 'undici', 'node-fetch', 'got', 'ky', 'requests', 'httpx'],
  },
  {
    kind: 'mcp',
    detail: 'Model Context Protocol SDK dependency',
    names: ['@modelcontextprotocol/sdk', 'mcp'],
  },
  {
    kind: 'agent-card',
    detail: 'A2A SDK dependency',
    names: ['@a2a-js/sdk', 'a2a-sdk'],
  },
  {
    kind: 'broker',
    detail: 'Message broker client dependency',
    names: [
      'kafkajs',
      'amqplib',
      '@aws-sdk/client-sqs',
      'nats',
      '@google-cloud/pubsub',
      'bullmq',
      'bull',
    ],
  },
  {
    kind: 'cache',
    detail: 'Cache dependency',
    names: ['redis', 'ioredis', 'lru-cache', 'node-cache', 'keyv', 'memcached'],
  },
  {
    kind: 'scheduler',
    detail: 'Scheduler dependency',
    names: ['node-cron', 'cron', 'node-schedule', 'agenda', 'bullmq', 'bree'],
  },
  {
    kind: 'resilience',
    detail: 'Retry, timeout or circuit-breaker dependency',
    names: [
      'opossum',
      'cockatiel',
      'p-retry',
      'async-retry',
      'p-timeout',
      'tenacity',
    ],
  },
  {
    kind: 'tracing',
    detail: 'Trace propagation dependency',
    names: [
      '@opentelemetry/api',
      '@opentelemetry/sdk-node',
      'opentelemetry-api',
    ],
  },
  {
    kind: 'auth',
    detail: 'Authentication dependency',
    names: [
      'passport',
      'jsonwebtoken',
      'jose',
      'openid-client',
      'oauth4webapi',
    ],
  },
];
const lexicalMarkers: {
  kind: WorkspaceFinding['kind'];
  name: string;
  pattern: RegExp;
}[] = [
  {
    kind: 'idempotency',
    name: 'idempotency key',
    pattern: /idempotency[-_ ]?key/i,
  },
  {
    kind: 'resilience',
    name: 'timeout or retry handling',
    pattern:
      /AbortSignal\.timeout|\bretr(?:y|ies)\b|backoff|circuit[-_ ]?breaker/i,
  },
  {
    kind: 'tracing',
    name: 'trace context',
    pattern: /traceparent|@opentelemetry\//,
  },
  {
    kind: 'scheduler',
    name: 'periodic schedule',
    pattern: /\bsetInterval\(|\bcron\b/,
  },
  {
    kind: 'broker',
    name: 'message channel',
    pattern: /\bkafka|\bamqp|rabbitmq|\bsqs\b|\bnats\b|pubsub/i,
  },
  {
    kind: 'cache',
    name: 'cache use',
    pattern: /cache-control|lru-?cache|\bioredis\b|\bredis\b/i,
  },
  {
    kind: 'auth',
    name: 'authentication',
    pattern: /\bauthorization\b|\bbearer\b|\bmtls\b|\boauth/i,
  },
];
const httpMethods = ['get', 'head', 'put', 'patch', 'delete', 'post'] as const;
const staticEvidence = (
  note: string,
  type: string,
  location: string,
): Evidence => ({ kind: 'static', note, source: { type, location } });
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'operation';
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hasRef = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hasRef)
    : isObject(v)
      ? Object.hasOwn(v, '$ref') || Object.values(v).some(hasRef)
      : false;
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Indexing cancelled');
};
interface ScannedFile {
  path: string;
  text: string;
}
async function scan(
  root: string,
  limits: typeof indexLimits,
  signal?: AbortSignal,
) {
  const files: ScannedFile[] = [];
  let total = 0,
    truncated = false,
    oversized = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    aborted(signal);
    if (depth > limits.depth) {
      truncated = true;
      return;
    }
    const entries = (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        secretFile.test(entry.name) ||
        testFile.test(entry.name)
      )
        continue;
      if (!textExtensions.has(extname(entry.name).toLowerCase())) continue;
      if (files.length >= limits.files) {
        truncated = true;
        return;
      }
      const size = (await stat(full)).size;
      if (size > limits.fileBytes) {
        oversized++;
        continue;
      }
      if (total + size > limits.totalBytes) {
        truncated = true;
        return;
      }
      total += size;
      files.push({
        path: relative(root, full).split(sep).join('/'),
        text: await readFile(full, 'utf8'),
      });
    }
  };
  await walk(root, 0);
  return { files, truncated, oversized };
}
const unknownSemantics = (evidence: Evidence): Semantics => ({
  effect: 'unknown',
  idempotent: null,
  outputMeaning: null,
  cachePermission: null,
  scope: 'unknown',
  keyDimensions: [],
  keysComplete: null,
  requiresLiveValidation: true,
  evidence,
});
function jsonSchemaOf(content: unknown): JsonObject | null {
  if (!isObject(content)) return null;
  const media = content['application/json'];
  if (!isObject(media) || !isObject(media.schema) || hasRef(media.schema))
    return null;
  return media.schema as JsonObject;
}
function openApiOperations(doc: Record<string, unknown>, location: string) {
  const ops: (Operation & { method: string; path: string })[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isObject(item)) continue;
    for (const method of httpMethods) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const keyed = params.some(
        (p) =>
          isObject(p) &&
          p.in === 'header' &&
          typeof p.name === 'string' &&
          p.name.toLowerCase() === 'idempotency-key',
      );
      const effect =
        method === 'get' || method === 'head'
          ? 'read'
          : method === 'post'
            ? 'unknown'
            : 'write';
      const responses = isObject(op.responses) ? op.responses : {};
      const success = ['200', '201', '202'].find((c) => isObject(responses[c]));
      const evidence = staticEvidence(
        `${method.toUpperCase()} ${path} in an OpenAPI document; effect from HTTP method semantics, verify against the implementation.`,
        'openapi',
        location,
      );
      ops.push({
        method,
        path,
        id: slug(
          typeof op.operationId === 'string'
            ? op.operationId
            : `${method}-${path}`,
        ),
        interfaceId: 'http-server',
        description:
          typeof op.summary === 'string'
            ? op.summary
            : `${method.toUpperCase()} ${path}`,
        inputSchema: isObject(op.requestBody)
          ? jsonSchemaOf(op.requestBody.content)
          : null,
        outputSchema: success
          ? jsonSchemaOf(
              (responses[success] as Record<string, unknown>).content,
            )
          : null,
        semantics: {
          ...unknownSemantics(evidence),
          effect,
          idempotencyKeySupported: keyed ? true : null,
        },
      });
    }
  }
  return ops;
}
function parseStructured(file: ScannedFile): unknown {
  const ext = extname(file.path).toLowerCase();
  if (ext === '.json') return JSON.parse(file.text);
  if (ext === '.yaml' || ext === '.yml')
    return parse(file.text, { maxAliasCount: 0 });
  return undefined;
}
const hostPattern =
  /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*)/gi;
const lineOf = (text: string, index: number) =>
  text.slice(0, index).split('\n').length;
export const workspaceIndexFile = (dir: string) =>
  join(resolve(dir), '.plug', 'workspace-index.json');
/** Indexes and atomically replaces `<dir>/.plug/workspace-index.json`. */
export async function writeWorkspaceIndex(
  dir: string,
  options: IndexOptions = {},
): Promise<WorkspaceIndex> {
  const index = await indexWorkspace(dir, options);
  const file = workspaceIndexFile(dir);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(index, null, 2) + '\n');
  await rename(temp, file);
  return index;
}
/** Bounded, deterministic, local-only scan. Never follows symbolic links, never reads secrets, never opens a network connection. */
export async function indexWorkspace(
  dir: string,
  options: IndexOptions = {},
): Promise<WorkspaceIndex> {
  const limits = { ...indexLimits, ...options.limits };
  const root = resolve(dir);
  if (!(await stat(root)).isDirectory())
    throw new Error('Index target must be a directory');
  const {
    files,
    truncated: scanTruncated,
    oversized,
  } = await scan(root, limits, options.signal);
  const findings: WorkspaceFinding[] = [];
  const gaps: string[] = [];
  let truncated = scanTruncated;
  const add = (f: WorkspaceFinding) => {
    if (findings.length >= limits.findings) {
      truncated = true;
      return;
    }
    if (
      findings.some(
        (x) =>
          x.kind === f.kind &&
          x.name === f.name &&
          x.evidence.source?.location === f.evidence.source?.location,
      )
    )
      return;
    findings.push(f);
  };
  const operations: Operation[] = [];
  const interfaces: Interface[] = [];
  const addInterface = (i: Interface) => {
    if (!interfaces.some((x) => x.id === i.id)) interfaces.push(i);
  };
  let projectName: string | null = null;
  let broker = false;
  const hosts = new Set<string>();
  const deps = new Set<string>();
  for (const file of files) {
    aborted(options.signal);
    const name = basename(file.path);
    const ext = extname(file.path).toLowerCase();
    if (name === 'package.json') {
      try {
        const pkg = JSON.parse(file.text);
        if (!isObject(pkg)) continue;
        if (file.path === 'package.json' && typeof pkg.name === 'string')
          projectName = pkg.name;
        const declared = new Set(
          ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(
            (key) => (isObject(pkg[key]) ? Object.keys(pkg[key]) : []),
          ),
        );
        for (const d of declared) deps.add(d);
        for (const m of dependencyMarkers)
          for (const d of m.names.filter((n) => declared.has(n)))
            add({
              kind: m.kind,
              name: d,
              detail: m.detail,
              evidence: staticEvidence(
                'Declared dependency; presence does not prove use on the selected path.',
                'package-manifest',
                file.path,
              ),
            });
      } catch {
        gaps.push(`${file.path}: package manifest could not be parsed`);
      }
      continue;
    }
    if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
      let doc: unknown;
      try {
        doc = parseStructured(file);
        guardDocument(doc);
      } catch (e) {
        if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(file.text))
          gaps.push(
            `${file.path}: OpenAPI document not indexed (${(e as Error).message})`,
          );
        continue;
      }
      if (!isObject(doc)) continue;
      if (
        (typeof doc.openapi === 'string' || typeof doc.swagger === 'string') &&
        isObject(doc.paths)
      ) {
        const ops = openApiOperations(doc, file.path);
        add({
          kind: 'interface',
          name: 'openapi',
          detail: `OpenAPI ${String(doc.openapi ?? doc.swagger)} document with ${ops.length} operation(s)`,
          evidence: staticEvidence('OpenAPI document', 'openapi', file.path),
        });
        for (const op of ops) {
          add({
            kind: 'operation',
            name: op.id,
            detail: `${op.method.toUpperCase()} ${op.path}`,
            evidence: op.semantics.evidence,
          });
          if (op.semantics.idempotencyKeySupported)
            add({
              kind: 'idempotency',
              name: op.id,
              detail: 'Accepts an Idempotency-Key header',
              evidence: op.semantics.evidence,
            });
          if (op.inputSchema || op.outputSchema)
            add({
              kind: 'schema',
              name: op.id,
              detail: [
                op.inputSchema && 'request schema',
                op.outputSchema && 'response schema',
              ]
                .filter(Boolean)
                .join(' and '),
              evidence: op.semantics.evidence,
            });
          else
            gaps.push(
              `${op.id}: structured request/response schemas are missing or use $ref; supply resolved schemas`,
            );
          const { method: _m, path: _p, ...operation } = op;
          if (!operations.some((o) => o.id === operation.id))
            operations.push(operation);
        }
        if (ops.length)
          addInterface({
            id: 'http-server',
            protocol: 'http',
            version: '1.1',
            direction: 'exposes',
            binding: 'HTTP+JSON',
          });
        continue;
      }
      if (Array.isArray(doc.supportedInterfaces) && Array.isArray(doc.skills)) {
        try {
          const review = importA2a(doc, 'a2a-agent');
          add({
            kind: 'agent-card',
            name: review.system.name,
            detail: `A2A Agent Card with ${review.system.operations.length} skill(s)`,
            evidence: staticEvidence('A2A Agent Card', 'agent-card', file.path),
          });
          for (const i of review.system.interfaces) {
            const { endpoint: _e, ...rest } = i;
            addInterface(rest);
          }
          for (const { metadata: _m, ...op } of review.system.operations)
            if (!operations.some((o) => o.id === op.id))
              operations.push({
                ...op,
                semantics: unknownSemantics(
                  staticEvidence(
                    'A2A skill; skill prose does not establish effect or contracts.',
                    'agent-card',
                    file.path,
                  ),
                ),
              });
        } catch (e) {
          gaps.push(
            `${file.path}: Agent Card rejected (${(e as Error).message})`,
          );
        }
      }
      continue;
    }
    if (!sourceExtensions.has(ext)) continue;
    const text = file.text;
    if (/@modelcontextprotocol\/sdk|from mcp\b|import mcp\b/.test(text)) {
      const tools = [
        ...text.matchAll(
          /\b(?:registerTool|\.tool)\(\s*['"`]([\w.-]{1,64})['"`]/g,
        ),
      ];
      add({
        kind: 'mcp',
        name: 'mcp-server',
        detail: tools.length
          ? `MCP tool registrations: ${tools.map((t) => t[1]).join(', ')}`
          : 'MCP SDK import',
        evidence: staticEvidence('MCP SDK usage', 'source', file.path),
      });
      for (const t of tools) {
        if (operations.some((o) => o.id === t[1])) continue;
        addInterface({
          id: 'mcp',
          protocol: 'mcp',
          version: 'unknown',
          direction: 'exposes',
          binding: 'MCP',
        });
        operations.push({
          id: t[1],
          interfaceId: 'mcp',
          description: `MCP tool ${t[1]}`,
          inputSchema: null,
          outputSchema: null,
          semantics: unknownSemantics(
            staticEvidence(
              'MCP tool registration; annotations are hints only.',
              'source',
              `${file.path}:${lineOf(text, t.index!)}`,
            ),
          ),
        });
      }
    }
    for (const m of lexicalMarkers) {
      const match = m.pattern.exec(text);
      if (!match) continue;
      if (m.kind === 'broker') broker = true;
      add({
        kind: m.kind,
        name: m.name,
        detail: `Lexical marker "${match[0]}"`,
        evidence: staticEvidence(
          'Lexical marker; review whether it lies on the selected path.',
          'source',
          `${file.path}:${lineOf(text, match.index)}`,
        ),
      });
    }
    for (const match of text.matchAll(hostPattern)) {
      if (hosts.size >= limits.hosts) break;
      const host = match[1].toLowerCase();
      if (hosts.has(host)) continue;
      hosts.add(host);
      add({
        kind: 'interface',
        name: host,
        detail: 'Outbound host reference (hostname only)',
        evidence: staticEvidence(
          'URL literal; only the hostname is recorded.',
          'source',
          `${file.path}:${lineOf(text, match.index!)}`,
        ),
      });
    }
  }
  if (findings.some((f) => f.kind === 'broker')) broker = true;
  if (hosts.size || dependencyMarkers[1].names.some((n) => deps.has(n)))
    addInterface({
      id: 'http-client',
      protocol: 'http',
      version: '1.1',
      direction: 'calls',
      binding: 'HTTP+JSON',
    });
  if (
    !operations.some((o) => o.interfaceId === 'http-server') &&
    dependencyMarkers[0].names.some((n) => deps.has(n))
  )
    gaps.push(
      'An HTTP server framework is declared but no OpenAPI document was found; describe the exposed operations.',
    );
  if (operations.length > 4)
    gaps.push(
      `${operations.length} operations found; the draft keeps the first four. Select the operations on the connection path.`,
    );
  const selected = operations.slice(0, 4);
  const usedInterfaces = interfaces.filter(
    (i) =>
      selected.some((o) => o.interfaceId === i.id) || i.direction === 'calls',
  );
  const rootName = basename(root);
  const system: SystemDescription | null = selected.length
    ? {
        id: slug(projectName ?? rootName),
        name: projectName ?? rootName,
        role: 'current project',
        interfaces: usedInterfaces,
        operations: selected,
        trustDomain: null,
        ...(broker
          ? {
              messaging: {
                delivery: 'unknown' as const,
                ordering: 'unknown' as const,
                durable: null,
                dlq: null,
              },
            }
          : {}),
      }
    : null;
  if (!system)
    gaps.push(
      'No operation was found in OpenAPI documents, Agent Cards or MCP tool registrations; describe the system manually.',
    );
  for (const op of selected)
    gaps.push(
      `${op.id}: latency distribution and hard timeout`,
      `${op.id}: calls-per-minute quota, concurrency and availability`,
      `${op.id}: change interval, source timestamp and source lag`,
      `${op.id}: cache permission, sharing scope and complete key dimensions`,
      `${op.id}: output meaning, effect and idempotency`,
    );
  if (system) {
    gaps.push('Trust domain of the project');
    gaps.push('Workload: request rate, burst rate and a request trace');
  }
  if (broker)
    gaps.push(
      'Delivery guarantee, ordering, durability and dead-letter handling of the message channel',
    );
  if (oversized)
    gaps.push(
      `${oversized} file(s) above ${limits.fileBytes} bytes were not read`,
    );
  if (truncated)
    gaps.push('The scan reached a bound; findings are incomplete.');
  const fingerprint = createHash('sha256');
  for (const f of files)
    fingerprint
      .update(f.path)
      .update('\0')
      .update(createHash('sha256').update(f.text).digest('hex'))
      .update('\n');
  const index: WorkspaceIndex = {
    formatVersion: '0.2-alpha.1',
    indexerVersion,
    root: rootName,
    scannedAt: (options.now?.() ?? new Date()).toISOString(),
    fingerprint: fingerprint.digest('hex'),
    filesScanned: files.length,
    truncated,
    findings,
    system,
    gaps: [...new Set(gaps)],
  };
  assertContract('WorkspaceIndex', index);
  return index;
}
