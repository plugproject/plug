import {
  assertContract,
  checkSchemaDialect,
  compileOperationSchema,
  guardDocument,
  parseInput,
} from '../contracts/index';
import type {
  Evidence,
  JsonObject,
  JsonValue,
  Operation,
  Semantics,
  SystemDescription,
} from '../contracts/index';
export interface ImportReview {
  system: SystemDescription;
  gaps: string[];
  metadataUnderstood: boolean;
  executableHere: false;
}
const unknownSemantics = (): Semantics => ({
  effect: 'unknown',
  idempotent: null,
  outputMeaning: null,
  cachePermission: null,
  scope: 'unknown',
  keyDimensions: [],
  keysComplete: null,
  requiresLiveValidation: true,
  evidence: {
    kind: 'unknown',
    note: 'Supply operational facts; metadata annotations are hints only.',
  },
});
function object(v: unknown, label: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`${label} must be an object`);
  return v as Record<string, any>;
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hasRef = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hasRef)
    : isObject(v)
      ? Object.hasOwn(v, '$ref') || Object.values(v).some(hasRef)
      : false;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'operation';
const httpMethods = [
  'get',
  'head',
  'put',
  'patch',
  'delete',
  'post',
  'options',
  'trace',
] as const;
const responseUnknown = (dataAtRoot: boolean) => ({
  dataPointer: dataAtRoot ? '' : null,
  snapshotPointer: null,
  snapshotHeader: null,
  timestampFormat: 'unknown' as const,
});
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number')
    return Number.isFinite(value) && Math.abs(value) <= 1e15;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
        isJsonValue(item),
    )
  );
};
const credentialName = (name: string) =>
  /(authorization|api[-_. ]?key|access[-_. ]?token|refresh[-_. ]?token|client[-_. ]?secret|password|credential|cookie)/i.test(
    name,
  );
const envName = (name: string) =>
  name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'CREDENTIAL';
const envReference = (name: string) => `\${env:${envName(name)}}`;
const dimension = (name: string) => `{${name}}`;
function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = url.password = url.search = url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function jsonMediaOf(content: unknown): Record<string, unknown> | null {
  if (!isObject(content)) return null;
  const media = content['application/json'];
  return isObject(media) ? media : null;
}
function scrubCredentialSchema(value: JsonValue, sensitive = false): JsonValue {
  if (Array.isArray(value))
    return value.map((item) => scrubCredentialSchema(item, sensitive));
  if (!isObject(value)) return value;
  const result: JsonObject = {};
  for (const [name, item] of Object.entries(value)) {
    if (
      sensitive &&
      ['example', 'examples', 'default', 'const', 'enum'].includes(name)
    )
      continue;
    if (name === 'properties' && isObject(item)) {
      const properties: JsonObject = {};
      for (const [property, schema] of Object.entries(item))
        if (isJsonValue(schema))
          properties[property] = scrubCredentialSchema(
            schema,
            sensitive || credentialName(property),
          );
      result[name] = properties;
    } else if (isJsonValue(item))
      result[name] = scrubCredentialSchema(item, sensitive);
  }
  return result;
}
function jsonSchemaOf(
  content: unknown,
  scrubCredentials = false,
): JsonObject | null {
  const media = jsonMediaOf(content);
  if (!isObject(media) || !isObject(media.schema) || hasRef(media.schema))
    return null;
  const schema = media.schema as JsonObject;
  return scrubCredentials
    ? (scrubCredentialSchema(schema) as JsonObject)
    : schema;
}
function schemaValidator(
  schema: unknown,
  protocol = 'http',
): ((value: unknown) => boolean) | null {
  if (!isObject(schema) || hasRef(schema)) return null;
  try {
    return compileOperationSchema(schema as JsonObject, protocol);
  } catch {
    return null;
  }
}
function rawExamples(holder: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (Object.hasOwn(holder, 'example')) values.push(holder.example);
  if (Array.isArray(holder.examples)) values.push(...holder.examples);
  else if (isObject(holder.examples))
    for (const example of Object.values(holder.examples))
      if (isObject(example) && Object.hasOwn(example, 'value'))
        values.push(example.value);
  if (Object.hasOwn(holder, 'default')) values.push(holder.default);
  if (Object.hasOwn(holder, 'const')) values.push(holder.const);
  if (Array.isArray(holder.enum)) values.push(...holder.enum);
  return values;
}
function schemaExamples(
  holder: Record<string, unknown>,
  schema: unknown,
  protocol = 'http',
): JsonValue[] {
  if (!isObject(schema)) return [];
  const validate = schemaValidator(schema, protocol);
  if (!validate) return [];
  const seen = new Set<string>();
  return [...rawExamples(holder), ...rawExamples(schema)].flatMap((value) => {
    if (!isJsonValue(value) || !validate(value)) return [];
    const key = JSON.stringify(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [structuredClone(value)];
  });
}
/** Builds a value only from mechanically explicit schema values. */
function valueFromSchema(
  schema: unknown,
  protocol = 'http',
): JsonValue | undefined {
  if (!isObject(schema) || hasRef(schema)) return undefined;
  const direct = schemaExamples(schema, schema, protocol)[0];
  if (direct !== undefined) return direct;
  if (schema.type !== 'object' || !isObject(schema.properties))
    return undefined;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((v): v is string => typeof v === 'string')
      : [],
  );
  const value: JsonObject = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const found = valueFromSchema(property, protocol);
    if (found !== undefined) value[name] = found;
    else if (required.has(name)) return undefined;
  }
  const validate = schemaValidator(schema, protocol);
  return validate?.(value) ? value : undefined;
}
function containsCredential(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([name, item]) => credentialName(name) || containsCredential(item),
  );
}
function templatedValue(
  value: JsonValue,
  samples: JsonObject,
  path = '',
): JsonValue {
  if (Array.isArray(value))
    return value.map((item, index) =>
      templatedValue(item, samples, path ? `${path}.${index}` : String(index)),
    );
  if (isObject(value)) {
    const result: JsonObject = {};
    for (const [name, item] of Object.entries(value))
      result[name] = templatedValue(
        item,
        samples,
        path ? `${path}.${name}` : name,
      );
    return result;
  }
  const name = path || 'body';
  samples[name] = value;
  return dimension(name);
}
function placeholders(value: JsonValue, found = new Set<string>()) {
  if (typeof value === 'string') {
    if (!value.startsWith('${env:'))
      for (const match of value.matchAll(/\{([^{}]+)\}/g)) found.add(match[1]);
  } else if (Array.isArray(value))
    value.forEach((item) => placeholders(item, found));
  else if (isObject(value))
    Object.values(value).forEach((item) => placeholders(item, found));
  return found;
}
function uniqueParameters(
  pathParameters: unknown,
  operationParameters: unknown,
): Record<string, unknown>[] {
  const found = new Map<string, Record<string, unknown>>();
  for (const parameter of [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(Array.isArray(operationParameters) ? operationParameters : []),
  ])
    if (
      isObject(parameter) &&
      typeof parameter.name === 'string' &&
      typeof parameter.in === 'string'
    )
      found.set(`${parameter.in}\0${parameter.name}`, parameter);
  return [...found.values()];
}
function securityHeaders(
  doc: Record<string, unknown>,
  operation: Record<string, unknown>,
): Record<string, string> {
  const security = Object.hasOwn(operation, 'security')
    ? operation.security
    : doc.security;
  if (
    !Array.isArray(security) ||
    !security.length ||
    security.some(
      (requirement) =>
        isObject(requirement) && !Object.keys(requirement).length,
    )
  )
    return {};
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes)
    ? components.securitySchemes
    : {};
  const headers: Record<string, string> = {};
  for (const requirement of security) {
    if (!isObject(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      const scheme = schemes[name];
      if (!isObject(scheme) || Object.hasOwn(scheme, '$ref')) continue;
      if (
        scheme.type === 'apiKey' &&
        scheme.in === 'header' &&
        typeof scheme.name === 'string'
      )
        headers[scheme.name] = envReference(scheme.name);
      else if (
        scheme.type === 'http' ||
        scheme.type === 'oauth2' ||
        scheme.type === 'openIdConnect'
      )
        headers.Authorization = envReference('Authorization');
    }
  }
  return headers;
}
function successResponse(operation: Record<string, unknown>) {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const code = [
    '200',
    '201',
    '202',
    '203',
    '204',
    '205',
    '206',
    '207',
    '208',
  ].find((candidate) => isObject(responses[candidate]));
  const fallback = Object.keys(responses)
    .sort()
    .find(
      (candidate) =>
        /^2(?:\d\d|XX)$/i.test(candidate) && isObject(responses[candidate]),
    );
  const response = responses[code ?? fallback ?? ''];
  return isObject(response) ? response : null;
}
function openApiBinding(
  doc: Record<string, unknown>,
  operation: Record<string, unknown>,
  method: string,
  path: string,
  parameters: Record<string, unknown>[],
  location: string,
): NonNullable<Operation['binding']> {
  const query: Record<string, string> = {};
  const headers = securityHeaders(doc, operation);
  const dimensions = new Map<string, JsonValue[]>();
  for (const parameter of parameters) {
    const name = parameter.name as string;
    const where = parameter.in;
    if (where === 'query' && !credentialName(name))
      query[name] = dimension(name);
    if (where === 'header')
      headers[name] = credentialName(name)
        ? envReference(name)
        : dimension(name);
    if (
      ((where === 'path' || where === 'query') && !credentialName(name)) ||
      (where === 'header' && !credentialName(name))
    ) {
      const values = schemaExamples(parameter, parameter.schema).filter(
        (value) =>
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean',
      );
      if (values.length) dimensions.set(name, values);
    }
  }

  const requestBody = isObject(operation.requestBody)
    ? operation.requestBody
    : null;
  const media = requestBody ? jsonMediaOf(requestBody.content) : null;
  const bodySchema = media?.schema;
  const safeBodySchema = isJsonValue(bodySchema)
    ? scrubCredentialSchema(bodySchema)
    : bodySchema;
  const bodyValues = media ? schemaExamples(media, bodySchema) : [];
  const derivedBody = valueFromSchema(safeBodySchema);
  if (derivedBody !== undefined && !bodyValues.length)
    bodyValues.push(derivedBody);
  const bodyContexts: JsonObject[] = [];
  let bodyTemplate: JsonValue | null = null;
  for (const value of bodyValues) {
    if (containsCredential(value)) continue;
    const context: JsonObject = {};
    const template = templatedValue(value, context);
    if (bodyTemplate === null) bodyTemplate = template;
    bodyContexts.push(context);
  }

  const allTemplates: JsonValue = {
    path,
    query,
    headers,
    body: bodyTemplate,
  };
  const needed = placeholders(allTemplates);
  const variantCount = Math.max(
    1,
    ...[...dimensions.values()].map((values) => values.length),
    bodyContexts.length,
  );
  const samples: JsonObject[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(variantCount, 20); index++) {
    const sample: JsonObject = {};
    for (const [name, values] of dimensions)
      sample[name] = values[index] ?? values[0];
    Object.assign(sample, bodyContexts[index] ?? bodyContexts[0] ?? {});
    if ([...needed].some((name) => !Object.hasOwn(sample, name))) continue;
    const key = JSON.stringify(sample);
    if (!seen.has(key)) {
      seen.add(key);
      samples.push(sample);
    }
  }
  const response = successResponse(operation);
  const dataAtRoot = !!response && !!jsonMediaOf(response.content);
  return {
    request: {
      protocol: 'http',
      method: method.toUpperCase(),
      pathTemplate: path,
      query,
      headers,
      bodyTemplate,
      samples,
      samplesEvidence: {
        kind: 'static',
        note: samples.length
          ? `${samples.length} complete request sample(s) derived from schema-valid OpenAPI examples, defaults or enums.`
          : 'No complete schema-valid request sample was declared by OpenAPI; request values remain unknown.',
        source: { type: 'openapi', location },
      },
    },
    response: responseUnknown(dataAtRoot),
  };
}
/** Object schema for the query and path parameters that carry resolved schemas; null when there are none. */
function parameterSchema(params: unknown[]): JsonObject | null {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    if (!isObject(p) || typeof p.name !== 'string' || !p.name) continue;
    if (p.in !== 'query' && p.in !== 'path') continue;
    if (!isObject(p.schema) || hasRef(p.schema)) continue;
    properties[p.name] = credentialName(p.name)
      ? scrubCredentialSchema(p.schema as JsonObject, true)
      : p.schema;
    if (p.required === true || p.in === 'path') required.push(p.name);
  }
  if (!Object.keys(properties).length) return null;
  return {
    type: 'object',
    properties: properties as JsonObject,
    ...(required.length ? { required } : {}),
  };
}
/**
 * Drafts operations from an OpenAPI document in path order. Each keeps its
 * method and path under `metadata.http` so an export can name the real call.
 */
export function openApiOperations(
  doc: Record<string, unknown>,
  location: string,
  interfaceId = 'http-server',
): Operation[] {
  const ops: Operation[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isObject(item)) continue;
    for (const method of httpMethods) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = uniqueParameters(item.parameters, op.parameters);
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
      const success = successResponse(op);
      const evidence: Evidence = {
        kind: 'static',
        note: `${method.toUpperCase()} ${path} in an OpenAPI document; effect from HTTP method semantics, verify against the implementation.`,
        source: { type: 'openapi', location },
      };
      ops.push({
        id: slug(
          typeof op.operationId === 'string'
            ? op.operationId
            : `${method}-${path}`,
        ),
        interfaceId,
        description:
          typeof op.summary === 'string'
            ? op.summary
            : `${method.toUpperCase()} ${path}`,
        inputSchema:
          (isObject(op.requestBody)
            ? jsonSchemaOf(op.requestBody.content, true)
            : null) ?? parameterSchema(params),
        outputSchema: success ? jsonSchemaOf(success.content) : null,
        semantics: {
          ...unknownSemantics(),
          effect,
          idempotencyKeySupported: keyed ? true : null,
          evidence,
        },
        binding: openApiBinding(doc, op, method, path, params, location),
        metadata: { http: { method, path } },
      });
    }
  }
  return ops;
}
export interface OpenApiSystemArgs {
  id: string;
  name: string;
  /** The document's `openapi` (or `swagger`) version string. */
  openapiVersion: string;
  /** Absolute server URL, already resolved and stripped; null when unknown. */
  serverUrl: string | null;
  /** Drafted operations, as returned by `openApiOperations`. */
  operations: Operation[];
  /** The document URL, kept as provenance only. */
  documentUrl?: string;
}
/** Builds the reviewed system for operations drafted from an OpenAPI document. */
export function openApiSystem(args: OpenApiSystemArgs): ImportReview {
  const { id, name, openapiVersion, serverUrl, operations } = args;
  const endpoint = publicHttpUrl(serverUrl);
  const documentUrl = publicHttpUrl(args.documentUrl);
  if (!operations.length) throw new Error('Select operations before import');
  if (new Set(operations.map((o) => o.id)).size !== operations.length)
    throw new Error('Duplicate operation IDs in the document');
  const gaps = [
    'Supply QoS, source timestamp/lag, cache permission, scope, workload and UX. OpenAPI metadata does not verify these facts.',
    'Select caller operation and explicit mappings.',
  ];
  for (const o of operations) {
    try {
      if (o.inputSchema) checkSchemaDialect(o.inputSchema);
      if (o.outputSchema) checkSchemaDialect(o.outputSchema);
    } catch (e) {
      gaps.push(`Schema requires review: ${(e as Error).message}`);
    }
    if (!o.inputSchema) gaps.push(`${o.id}: input schema missing`);
    if (!o.outputSchema) gaps.push(`${o.id}: output schema missing`);
  }
  const understood = /^3\./.test(openapiVersion);
  if (!understood)
    gaps.push(
      'Unsupported OpenAPI version; metadata preserved without semantic compatibility claim.',
    );
  if (!endpoint)
    gaps.push(
      'The document names no absolute server URL; set the interface endpoint.',
    );
  const system: SystemDescription = {
    id,
    name,
    role: 'downstream',
    interfaces: [
      {
        id: 'http',
        protocol: 'http',
        version: '1.1',
        direction: 'exposes',
        binding: 'HTTP+JSON',
        ...(endpoint ? { endpoint } : {}),
      },
    ],
    operations: operations.map((o) => ({ ...o, interfaceId: 'http' })),
    metadata: {
      openapi: {
        version: openapiVersion,
        ...(documentUrl ? { url: documentUrl } : {}),
      },
    },
  };
  assertContract('SystemDescription', system);
  return {
    system,
    gaps,
    metadataUnderstood: understood,
    executableHere: false,
  };
}
/** Reviews a pasted or uploaded OpenAPI document; nothing is fetched or called. */
export function importOpenApi(
  raw: unknown,
  id = 'openapi-service',
): ImportReview {
  guardDocument(raw);
  const doc = object(raw, 'OpenAPI document');
  const version =
    typeof doc.openapi === 'string'
      ? doc.openapi
      : typeof doc.swagger === 'string'
        ? doc.swagger
        : null;
  if (!version || !isObject(doc.paths))
    throw new Error(
      'An OpenAPI document declares openapi (or swagger) and paths',
    );
  const operations = openApiOperations(doc, 'pasted-document', 'http');
  if (!operations.length)
    throw new Error('The OpenAPI document lists no operations');
  const info = isObject(doc.info) ? doc.info : {};
  const first = Array.isArray(doc.servers)
    ? doc.servers.find((s: unknown) => isObject(s) && typeof s.url === 'string')
    : undefined;
  let serverUrl: string | null = null;
  if (first) {
    serverUrl = publicHttpUrl((first as Record<string, unknown>).url);
  }
  return openApiSystem({
    id,
    name: typeof info.title === 'string' && info.title ? info.title : id,
    openapiVersion: version,
    serverUrl,
    operations,
  });
}
export function importMcp(raw: unknown): ImportReview {
  guardDocument(raw);
  const wrapper = object(raw, 'MCP wrapper');
  if (
    typeof wrapper.serverId !== 'string' ||
    !wrapper.serverId ||
    typeof wrapper.protocolVersion !== 'string'
  )
    throw new Error(
      'MCP import requires serverId and negotiated protocolVersion',
    );
  const pages = wrapper.pages ?? [wrapper.response];
  if (!Array.isArray(pages) || !pages.length)
    throw new Error('Supply tools/list response or ordered pages');
  const gaps = [
    'Supply QoS, source timestamp/lag, cache permission, scope, workload and UX. MCP hints do not verify these facts.',
    'Select caller operation and explicit mappings.',
  ];
  const understood = wrapper.protocolVersion === '2025-11-25';
  if (!understood)
    gaps.push(
      'Unsupported MCP version; metadata preserved without semantic compatibility claim.',
    );
  const operations: Operation[] = [];
  pages.forEach((page: unknown, i: number) => {
    const p = object(page, 'tools/list page');
    const result = object(p.result ?? p, 'tools/list result');
    if (!Array.isArray(result.tools)) throw new Error('Missing tools array');
    if (result.nextCursor && i === pages.length - 1)
      gaps.push(
        'INCOMPLETE_DISCOVERY: nextCursor remains; supply the remaining pages explicitly.',
      );
    for (const t of result.tools) {
      const tool = object(t, 'tool');
      if (
        typeof tool.name !== 'string' ||
        !tool.inputSchema ||
        Array.isArray(tool.inputSchema) ||
        typeof tool.inputSchema !== 'object'
      )
        throw new Error('MCP tools require a name and inputSchema object');
      try {
        checkSchemaDialect(tool.inputSchema);
        if (tool.outputSchema) checkSchemaDialect(tool.outputSchema);
      } catch (e) {
        gaps.push(`Schema requires review: ${(e as Error).message}`);
      }
      if (!tool.outputSchema) gaps.push(`${tool.name}: output schema missing`);
      const outputSchema = isObject(tool.outputSchema)
        ? (tool.outputSchema as JsonObject)
        : null;
      operations.push({
        id: tool.name,
        interfaceId: 'mcp',
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        outputSchema,
        semantics: unknownSemantics(),
        binding: {
          request: {
            protocol: 'mcp',
            method: 'tools/call',
            pathTemplate: '',
            query: {},
            headers: {},
            bodyTemplate: { name: tool.name },
            samples: [],
            samplesEvidence: {
              kind: 'static',
              note: 'The tool was safely inventoried with tools/list. tools/call remains ineligible until the author declares effect=read and idempotent=true.',
              source: { type: 'mcp', location: 'tools/list' },
            },
          },
          response: responseUnknown(!!outputSchema),
        },
        metadata: tool as JsonObject,
      });
    }
  });
  if (new Set(operations.map((o) => o.id)).size !== operations.length)
    throw new Error('Duplicate tool names across supplied pages');
  if (!operations.length) throw new Error('Select tools before import');
  const system: SystemDescription = {
    id: wrapper.serverId,
    name: wrapper.serverName ?? wrapper.serverId,
    role: 'downstream',
    interfaces: [
      {
        id: 'mcp',
        protocol: 'mcp',
        version: wrapper.protocolVersion,
        direction: 'exposes',
        binding: 'MCP',
      },
    ],
    operations,
    metadata: wrapper as JsonObject,
  };
  assertContract('SystemDescription', system);
  return {
    system,
    gaps,
    metadataUnderstood: understood,
    executableHere: false,
  };
}
/** Pre-1.0 cards name their transports in url, preferredTransport and additionalInterfaces. */
function legacyInterfaces(card: Record<string, any>): unknown[] | null {
  if (typeof card.url !== 'string') return null;
  const version =
    typeof card.protocolVersion === 'string' ? card.protocolVersion : 'unknown';
  const listed = [
    { url: card.url, transport: card.preferredTransport ?? 'JSONRPC' },
    ...(Array.isArray(card.additionalInterfaces)
      ? card.additionalInterfaces
      : []),
  ];
  const seen = new Set<string>();
  return listed.flatMap((v: unknown) => {
    const f = object(v, 'AgentInterface');
    if (typeof f.url !== 'string' || typeof f.transport !== 'string')
      throw new Error('AgentInterface requires url and transport');
    const key = `${f.transport} ${f.url}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      { url: f.url, protocolVersion: version, protocolBinding: f.transport },
    ];
  });
}
export function importA2a(raw: unknown, id = 'imported-agent'): ImportReview {
  guardDocument(raw);
  const card = object(raw, 'Agent Card');
  const declared =
    Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length
      ? card.supportedInterfaces
      : legacyInterfaces(card);
  if (
    typeof card.name !== 'string' ||
    !declared?.length ||
    !Array.isArray(card.skills) ||
    !card.skills.length
  )
    throw new Error('A2A 1.0 requires name, supportedInterfaces and skills');
  const interfaces = declared.map((v: unknown, i: number) => {
    const f = object(v, 'AgentInterface');
    if (
      typeof f.url !== 'string' ||
      typeof f.protocolVersion !== 'string' ||
      typeof f.protocolBinding !== 'string'
    )
      throw new Error(
        'AgentInterface requires url, protocolVersion and protocolBinding',
      );
    const endpoint = publicHttpUrl(f.url);
    if (!endpoint)
      throw new Error('AgentInterface URL must be an absolute HTTP(S) URL');
    return {
      id: `a2a-${i}`,
      protocol: 'a2a' as const,
      version: f.protocolVersion,
      direction: 'exposes' as const,
      binding: f.protocolBinding,
      endpoint,
    };
  });
  const gaps = [
    'Skill prose does not supply structured operation contracts: add input/output schemas and mappings.',
    'Streaming and push capabilities do not establish useful-output latency or data invalidation.',
    'Supply operational profile, effect, output meaning, cache permission and exact scope.',
  ];
  const understood = interfaces.every((i) => i.version === '1.0');
  if (!understood)
    gaps.push('Unsupported A2A interface version preserved for review.');
  if (declared !== card.supportedInterfaces)
    gaps.push(
      'Pre-1.0 Agent Card: transports were read from url, preferredTransport and additionalInterfaces.',
    );
  const operations: Operation[] = card.skills.map((s: unknown) => {
    const skill = object(s, 'skill');
    if (typeof skill.id !== 'string') throw new Error('Skill ID required');
    const inputModes = Array.isArray(skill.inputModes)
      ? skill.inputModes
      : card.defaultInputModes;
    const examples = Array.isArray(skill.examples)
      ? skill.examples.filter(
          (example: unknown): example is string =>
            typeof example === 'string' && !!example.trim(),
        )
      : [];
    const jsonRpc = interfaces.some(
      (face) =>
        face.id === interfaces[0].id &&
        face.binding.replace(/[^a-z]/gi, '').toLowerCase() === 'jsonrpc',
    );
    const textInput =
      Array.isArray(inputModes) && inputModes.includes('text/plain');
    const binding: Operation['binding'] | undefined =
      jsonRpc && textInput && examples.length
        ? {
            request: {
              protocol: 'a2a',
              method: 'message/send',
              pathTemplate: '',
              query: {},
              headers: {},
              bodyTemplate: {
                message: {
                  role: 'user',
                  parts: [{ kind: 'text', text: dimension('message') }],
                },
              },
              samples: examples.slice(0, 20).map((message: string) => ({
                message,
              })),
              samplesEvidence: {
                kind: 'static',
                note: 'Text request samples declared by the A2A Agent Card.',
                source: {
                  type: 'a2a',
                  location: `agent-card#skills/${encodeURIComponent(skill.id)}`,
                },
              },
            },
            response: responseUnknown(true),
          }
        : undefined;
    return {
      id: skill.id,
      interfaceId: interfaces[0].id,
      description: skill.description ?? skill.name ?? '',
      inputSchema: null,
      outputSchema: null,
      semantics: unknownSemantics(),
      ...(binding ? { binding } : {}),
      metadata: skill as JsonObject,
    };
  });
  const system: SystemDescription = {
    id,
    name: card.name,
    role: 'downstream',
    interfaces,
    operations,
    metadata: card as JsonObject,
  };
  assertContract('SystemDescription', system);
  return {
    system,
    gaps,
    metadataUnderstood: understood,
    executableHere: false,
  };
}
export function importDescription(
  text: string,
  kind: 'mcp' | 'a2a' | 'openapi' | 'manual',
): ImportReview {
  const raw = parseInput(text);
  if (kind === 'mcp') return importMcp(raw);
  if (kind === 'a2a') return importA2a(raw);
  if (kind === 'openapi') return importOpenApi(raw);
  assertContract<SystemDescription>('SystemDescription', raw);
  return {
    system: raw,
    gaps: [],
    metadataUnderstood: true,
    executableHere: false,
  };
}
