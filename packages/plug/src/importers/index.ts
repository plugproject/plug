import {
  assertContract,
  checkSchemaDialect,
  guardDocument,
  parseInput,
} from '../contracts/index';
import type {
  JsonObject,
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
      operations.push({
        id: tool.name,
        interfaceId: 'mcp',
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        semantics: unknownSemantics(),
        metadata: tool as JsonObject,
      });
    }
  });
  if (new Set(operations.map((o) => o.id)).size !== operations.length)
    throw new Error('Duplicate tool names across supplied pages');
  if (operations.length > 4 || !operations.length)
    throw new Error('Select one to four tools before import');
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
export function importA2a(raw: unknown, id = 'imported-agent'): ImportReview {
  guardDocument(raw);
  const card = object(raw, 'Agent Card');
  if (
    typeof card.name !== 'string' ||
    !Array.isArray(card.supportedInterfaces) ||
    !card.supportedInterfaces.length ||
    !Array.isArray(card.skills) ||
    !card.skills.length
  )
    throw new Error('A2A 1.0 requires name, supportedInterfaces and skills');
  const interfaces = card.supportedInterfaces.map((v: unknown, i: number) => {
    const f = object(v, 'AgentInterface');
    if (
      typeof f.url !== 'string' ||
      typeof f.protocolVersion !== 'string' ||
      typeof f.protocolBinding !== 'string'
    )
      throw new Error(
        'AgentInterface requires url, protocolVersion and protocolBinding',
      );
    return {
      id: `a2a-${i}`,
      protocol: 'a2a' as const,
      version: f.protocolVersion,
      direction: 'exposes' as const,
      binding: f.protocolBinding,
      endpoint: f.url,
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
  if (card.skills.length > 4)
    throw new Error('Select up to four skills before import');
  const operations: Operation[] = card.skills.map((s: unknown) => {
    const skill = object(s, 'skill');
    if (typeof skill.id !== 'string') throw new Error('Skill ID required');
    return {
      id: skill.id,
      interfaceId: interfaces[0].id,
      description: skill.description ?? skill.name ?? '',
      inputSchema: null,
      outputSchema: null,
      semantics: unknownSemantics(),
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
  kind: 'mcp' | 'a2a' | 'manual',
): ImportReview {
  const raw = parseInput(text);
  if (kind === 'mcp') return importMcp(raw);
  if (kind === 'a2a') return importA2a(raw);
  assertContract<SystemDescription>('SystemDescription', raw);
  return {
    system: raw,
    gaps: [],
    metadataUnderstood: true,
    executableHere: false,
  };
}
