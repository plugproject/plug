import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { adoptDesign, clearAdoptedDesign } from '../adoption/index';
import {
  assertContract,
  localDocumentLimit,
  parseInput,
  validateInput,
} from '../contracts/index';
import type {
  DesignInput,
  DesignRecommendation,
  SystemDescription,
} from '../contracts/index';
import { writeWorkspaceIndex } from '../indexer/index';
import {
  readSpecBundle,
  specDir,
  specFiles,
  summarize,
  writeSpecBundle,
} from '../openspec/bundle';
import { readSpecSource } from '../openspec/index';
import { listSpecRevisions, readSpecRevision } from '../openspec/revisions';
import {
  addAuthorizedHost,
  executeProbe,
  readOperationManifests,
} from '../probe/index';
import {
  effectiveArchitectureId,
  explainDesign,
  suggestDesign,
} from '../recommender/index';
import {
  readRecentReviews,
  reviewerFromEnv,
  reviewCheckerFromEnv,
  reviewDesign,
} from '../review/index';
import { readVerificationRecords, verifyEdge } from '../verify/index';
const argumentLimit = localDocumentLimit;
const longToolLimitMs = 120_000;
const ok = (value: unknown): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
});
const guarded =
  <A>(fn: (args: A, signal: AbortSignal) => Promise<unknown> | unknown) =>
  async (args: A, extra: { signal: AbortSignal }) => {
    try {
      if (
        new TextEncoder().encode(JSON.stringify(args ?? {})).length >
        argumentLimit
      )
        throw new Error('Tool arguments exceed 64 MB');
      return ok(await fn(args, extra.signal));
    } catch (e) {
      return fail(e);
    }
  };
const source = {
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('A Plug DesignInput (0.2-alpha.1 or 0.1-alpha.2).'),
  workflow: z
    .string()
    .max(argumentLimit)
    .optional()
    .describe(
      'An Open Workflow Specification 1.x document as YAML or JSON, e.g. the edited .plug/workflow.yaml.',
    ),
};
function sourceOf(args: { input?: unknown; workflow?: string }) {
  if ((args.input === undefined) === (args.workflow === undefined))
    throw new Error('Pass exactly one of input or workflow');
  return args.workflow === undefined ? args.input : parseInput(args.workflow);
}
const longSignal = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(longToolLimitMs)]);
/** What a coding agent needs per connection without reading the full report. */
function brief(
  input: DesignInput,
  design: DesignRecommendation,
  verifications: Awaited<ReturnType<typeof readVerificationRecords>> = [],
  revisionId: string | null = null,
) {
  return summarize(input, design).connections.map((s) => {
    const c = input.connections.find((x) => x.id === s.connectionId)!;
    const r = design.connections.find(
      (x) => x.connectionId === s.connectionId,
    )!;
    const architectureId = effectiveArchitectureId(r);
    const a = r.architectures.find((x) => x.id === architectureId);
    const verification = [...verifications]
      .reverse()
      .find(
        (record) =>
          record.connectionId === s.connectionId &&
          record.designHash === design.designHash &&
          record.revisionId === revisionId &&
          (record.mode === 'as-is' || record.architectureId === architectureId),
      );
    return {
      ...s,
      experience: {
        usefulOutput: c.experience.usefulOutput,
        latencyTargetMs: c.experience.latencyTargetMs,
        scope: c.experience.scope,
        targetPercentile: c.experience.targetPercentile,
        correctness: c.experience.correctness,
        maxAgeMs: c.experience.maxAgeMs,
      },
      priorities: r.priorities,
      patterns: a?.patterns ?? [],
      status: a?.status ?? null,
      tasks: a?.tasks ?? [],
      unknowns: a?.proof.unknowns ?? [],
      missingInformation: r.missingInformation,
      adoption: r.adoption ?? null,
      latestVerification: verification ?? null,
    };
  });
}
/** Plug itself as an MCP server; only explicit add/probe/verify tools call authorized endpoints. */
export function createPlugMcpServer(workspaceDir: string, version = '0.2.0') {
  const dir = resolve(workspaceDir);
  const server = new McpServer(
    { name: 'plug', version },
    {
      instructions:
        'Plug keeps the integration spec in .plug/. Read it before changing integrations. Adding a system authorizes inspection of everything it exposes; automatic calls remain limited to safe reads and writes are never auto-probed. Probe and verification records are local-workbench evidence, not production measurements or SLOs. Unknown facts stay unknown; never invent latency, quota or cache permission.',
    },
  );
  const local = { readOnlyHint: true, openWorldHint: false } as const;
  server.registerTool(
    'plug_get_spec',
    {
      title: 'Get the current Plug spec',
      description:
        'Returns the latest generated integration spec of this workspace: per connection the caller, downstream, required experience, priorities, selected architecture, implementation tasks and unknowns. Set include to also return file contents.',
      inputSchema: {
        include: z
          .array(z.enum(['workflow', 'input', 'design', 'explanation']))
          .optional(),
        revision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
          .describe('An exact retained OpenSpec revision ID.'),
      },
      annotations: local,
    },
    guarded(
      async ({
        include = [],
        revision,
      }: {
        include?: string[];
        revision?: string;
      }) => {
        if (revision) {
          const workflow = await readSpecRevision(dir, revision);
          if (workflow === null) throw new Error('Spec revision not found');
          const { input } = readSpecSource(parseInput(workflow));
          const design = suggestDesign(input);
          const generated: Record<string, string> = {
            workflow,
            input: `${JSON.stringify(input, null, 2)}\n`,
            design: `${JSON.stringify(design, null, 2)}\n`,
            explanation: explainDesign(design),
          };
          return {
            present: true,
            revisionId: revision,
            inputHash: design.inputHash,
            designHash: design.designHash,
            connections: brief(
              input,
              design,
              await readVerificationRecords(dir),
              revision,
            ),
            crossConnection: design.crossConnection,
            files: Object.fromEntries(
              include.map((key) => [
                specFiles[key as keyof typeof specFiles],
                generated[key] ?? '',
              ]),
            ),
          };
        }
        const state = await readSpecBundle(dir);
        if (!state.present)
          return {
            present: false,
            next: 'No spec yet. Call plug_update_spec with a DesignInput or workflow, or open the workbench with npx plug ui.',
          };
        const files: Record<string, string> = {};
        for (const key of include) {
          const name = specFiles[key as keyof typeof specFiles];
          files[name] = await readFile(join(specDir(dir), name), 'utf8').catch(
            () => '',
          );
        }
        return {
          present: true,
          consistent: state.consistent,
          workflowEdited: state.workflowEdited,
          problems: state.problems,
          inputHash: state.summary?.inputHash ?? null,
          designHash: state.summary?.designHash ?? null,
          revisionId: state.currentRevisionId,
          connections:
            state.input && state.design
              ? brief(
                  state.input,
                  state.design,
                  await readVerificationRecords(dir),
                  state.currentRevisionId,
                )
              : [],
          crossConnection: state.design?.crossConnection ?? [],
          files,
        };
      },
    ),
  );
  server.registerTool(
    'plug_update_spec',
    {
      title: 'Update the Plug spec',
      description:
        'Validates a DesignInput or an edited workflow document, re-analyzes it and rewrites .plug/ (workflow.yaml, design-input.json, design.json, design.md, AGENTS.md). Use it after code changes alter an integration. Returns the selected architectures and every gap.',
      inputSchema: source,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args: { input?: unknown; workflow?: string }) => {
      const written = await writeSpecBundle(dir, sourceOf(args), 'mcp');
      const state = await readSpecBundle(dir);
      return {
        ...written,
        connections:
          state.input && state.design
            ? brief(state.input, state.design)
            : written.connections,
      };
    }),
  );
  server.registerTool(
    'plug_analyze',
    {
      title: 'Analyze without writing',
      description:
        'Validates and analyzes a DesignInput or workflow document and returns the selected architectures and gaps without changing .plug/.',
      inputSchema: source,
      annotations: local,
    },
    guarded((args: { input?: unknown; workflow?: string }) => {
      const { input, gaps, lossless } = readSpecSource(sourceOf(args));
      const design = suggestDesign(input);
      return {
        inputHash: design.inputHash,
        designHash: design.designHash,
        lossless,
        gaps,
        connections: brief(input, design),
        crossConnection: design.crossConnection,
      };
    }),
  );
  server.registerTool(
    'plug_index_workspace',
    {
      title: 'Index this workspace',
      description:
        'Runs the bounded, local-only workspace indexer (no network, no secrets, no symbolic links), writes .plug/workspace-index.json and returns the draft system and the facts Plug still needs.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (extra) =>
      guarded(async (_args: object, signal) => {
        const index = await writeWorkspaceIndex(dir, { signal });
        const counts: Record<string, number> = {};
        for (const f of index.findings)
          counts[f.kind] = (counts[f.kind] ?? 0) + 1;
        return {
          file: '.plug/workspace-index.json',
          filesScanned: index.filesScanned,
          truncated: index.truncated,
          findings: counts,
          system: index.system && {
            id: index.system.id,
            name: index.system.name,
            operations: index.system.operations.map((o) => o.id),
          },
          gaps: index.gaps,
        };
      })({}, extra),
  );
  server.registerTool(
    'plug_explain',
    {
      title: 'Explain the current design',
      description:
        'Returns the Markdown explanation (relation facts, frontier, proofs, implementation tasks) of the current spec, optionally for one connection.',
      inputSchema: { connectionId: z.string().max(200).optional() },
      annotations: local,
    },
    guarded(async ({ connectionId }: { connectionId?: string }) => {
      const state = await readSpecBundle(dir);
      if (!state.design)
        throw new Error(
          state.problems[0] ?? 'No spec yet. Call plug_update_spec first.',
        );
      const connections = connectionId
        ? state.design.connections.filter(
            (r) => r.connectionId === connectionId,
          )
        : state.design.connections;
      if (!connections.length)
        throw new Error(`Unknown connection ${connectionId}`);
      return explainDesign({ ...state.design, connections });
    }),
  );
  server.registerTool(
    'plug_add_system',
    {
      title: 'Add and optionally inspect a system',
      description:
        'Adds a system to the OpenSpec. Adding it authorizes local inspection of every endpoint it exposes; inspect=true immediately probes only protocol-safe reads under Plug’s 120-second bounds. Write operations are never automatically called. Probe evidence is local-workbench evidence, never a production measurement or SLO.',
      inputSchema: {
        system: z.record(z.string(), z.unknown()),
        inspect: z.boolean().describe('Whether to inspect immediately.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(
      async (
        {
          system,
          inspect,
        }: { system: Record<string, unknown>; inspect: boolean },
        signal,
      ) => {
        const state = await readSpecBundle(dir);
        if (!state.input)
          throw new Error('No spec exists. Call plug_update_spec first.');
        assertContract<SystemDescription>('SystemDescription', system);
        if (state.input.systems.some((candidate) => candidate.id === system.id))
          throw new Error(`System ${system.id} already exists.`);
        const input = structuredClone(state.input);
        input.systems.push(system);
        validateInput(input);
        for (const iface of system.interfaces)
          if (iface.endpoint)
            await addAuthorizedHost(dir, iface.endpoint, 'mcp');
        const written = await writeSpecBundle(dir, input, 'mcp');
        if (!inspect)
          return {
            systemId: system.id,
            inspected: false,
            disclosure:
              'The exposed endpoints are authorized but were not called.',
            revisionId: written.revisionId,
          };
        const result = await executeProbe(input, {
          workspace: dir,
          systemId: system.id,
          signal: longSignal(signal),
        });
        return {
          systemId: system.id,
          inspected: true,
          manifests: result.manifests,
          revisionId: result.revisionId,
          honesty:
            'Measurements are from this local workbench and are not production SLO evidence.',
        };
      },
    ),
  );
  server.registerTool(
    'plug_probe',
    {
      title: 'Inspect authorized integration points',
      description:
        'Calls only author-authorized, protocol-safe read operations with bounded concurrency, time, calls and bytes; first 429 stops that operation. It writes the manifest and probed facts. Results describe this local-workbench vantage, not production behavior or an SLO. Cache permission is never inferred.',
      inputSchema: {
        systemId: z.string().max(200).optional(),
        operationId: z.string().max(200).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(
      async (args: { systemId?: string; operationId?: string }, signal) => {
        const state = await readSpecBundle(dir);
        if (!state.input)
          throw new Error('No spec exists. Call plug_update_spec first.');
        const result = await executeProbe(state.input, {
          workspace: dir,
          ...args,
          signal: longSignal(signal),
        });
        return {
          manifests: result.manifests,
          updatedConnectionIds: result.updatedConnectionIds,
          revisionId: result.revisionId,
          honesty:
            'Local-workbench demonstration only; not production measurement or an SLO.',
        };
      },
    ),
  );
  server.registerTool(
    'plug_verify_edge',
    {
      title: 'Demonstrate an edge locally',
      description:
        'Runs a bounded workbench demonstration for the direct edge or selected design. It never runs write operations. demonstrated means only that these samples met the requirement from this vantage; it is not an SLO or production verification.',
      inputSchema: {
        connectionId: z.string().max(200),
        mode: z.enum(['as-is', 'design']),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(
      async (
        args: { connectionId: string; mode: 'as-is' | 'design' },
        signal,
      ) => {
        const state = await readSpecBundle(dir);
        if (!state.input)
          throw new Error('No spec exists. Call plug_update_spec first.');
        return verifyEdge(state.input, args.connectionId, args.mode, {
          workspace: dir,
          revisionId: state.currentRevisionId,
          signal: longSignal(signal),
        });
      },
    ),
  );
  server.registerTool(
    'plug_review_design',
    {
      title: 'Critique and adjudicate a design',
      description:
        'Sends only a bounded, scrubbed design slice to the configured critic and Jev. The engine remains the feasibility authority; the critic cannot change the design, and only code-verified, non-dominated alternatives are adoptable.',
      inputSchema: {
        connectionId: z.string().max(200),
        operationalContext: z.string().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(
      async (
        args: { connectionId: string; operationalContext?: string },
        signal,
      ) => {
        const state = await readSpecBundle(dir);
        if (!state.input || !state.design)
          throw new Error(
            'No consistent spec exists. Call plug_update_spec first.',
          );
        const connection = state.input.connections.find(
          (candidate) => candidate.id === args.connectionId,
        );
        if (!connection)
          throw new Error(`Unknown connection ${args.connectionId}.`);
        const manifests = await readOperationManifests(dir);
        const manifest =
          [...manifests]
            .reverse()
            .find(
              (candidate) =>
                candidate.systemId === connection.downstreamSystemId &&
                candidate.operationId === connection.downstreamOperationId,
            ) ?? null;
        const verification =
          (await readVerificationRecords(dir))
            .reverse()
            .find(
              (candidate) =>
                candidate.connectionId === args.connectionId &&
                candidate.designHash === state.design!.designHash &&
                candidate.revisionId === state.currentRevisionId,
            ) ?? null;
        const result = await reviewDesign(
          state.input,
          state.design,
          args.connectionId,
          reviewerFromEnv(process.env),
          reviewCheckerFromEnv(process.env),
          {
            operationalContext: args.operationalContext,
            manifest,
            verification,
            signal: longSignal(signal),
          },
        );
        await appendFile(
          join(dir, '.plug', 'reviews.jsonl'),
          `${JSON.stringify({
            ...result,
            specRevision: state.currentRevisionId,
            pinnedToRevision: true,
          })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
        return {
          ...result,
          specRevision: state.currentRevisionId,
          pinnedToRevision: true,
        };
      },
    ),
  );
  server.registerTool(
    'plug_adopt_design',
    {
      title: 'Adopt or clear an architecture',
      description:
        'Records the author’s explicit architecture choice in the OpenSpec. Plug deterministically re-verifies the exact pattern set and rejects infeasible or dominated choices. Models never adopt on the author’s behalf.',
      inputSchema: {
        connectionId: z.string().max(200),
        architectureId: z.string().max(1000).optional(),
        patterns: z.array(z.string().max(100)).max(20).optional(),
        reviewHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        clear: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(
      async (args: {
        connectionId: string;
        architectureId?: string;
        patterns?: string[];
        reviewHash?: string;
        clear?: boolean;
      }) => {
        const state = await readSpecBundle(dir);
        if (!state.input)
          throw new Error('No spec exists. Call plug_update_spec first.');
        if (args.clear) {
          const cleared = clearAdoptedDesign(state.input, args.connectionId);
          const written = await writeSpecBundle(dir, cleared.input, 'adopt');
          return {
            cleared: true,
            revisionId: written.revisionId,
            connections: brief(cleared.input, cleared.design),
          };
        }
        if (!args.architectureId)
          throw new Error('architectureId is required unless clear=true.');
        let review: Record<string, unknown> | null = null;
        if (args.reviewHash) {
          review =
            (await readRecentReviews(join(dir, '.plug', 'reviews.jsonl')))
              .reverse()
              .find(
                (candidate) =>
                  candidate.reviewHash === args.reviewHash &&
                  candidate.connectionId === args.connectionId,
              ) ?? null;
          const adoptable = (
            review?.decision as { adoptable?: unknown } | undefined
          )?.adoptable;
          if (
            !review ||
            !Array.isArray(adoptable) ||
            !adoptable.includes(args.architectureId)
          )
            throw new Error(
              'The pinned review does not mark this architecture adoptable.',
            );
        }
        const critic =
          typeof review?.criticModel === 'string'
            ? review.criticModel
            : 'no critic';
        const jev =
          typeof review?.jevModel === 'string' ? review.jevModel : 'unverified';
        const adopted = adoptDesign(state.input, args.connectionId, {
          architectureId: args.architectureId,
          patterns: args.patterns,
          evidence: {
            kind: 'declared',
            note:
              `Adopted by the author via MCP after design review by ${critic}; ` +
              `Jev ${jev}.`,
            source: {
              type: 'design-review',
              location: `${critic}@${args.reviewHash ?? 'author-choice'}`,
            },
          },
        });
        const written = await writeSpecBundle(dir, adopted.input, 'adopt');
        return {
          cleared: false,
          revisionId: written.revisionId,
          connections: brief(adopted.input, adopted.design),
        };
      },
    ),
  );
  server.registerTool(
    'plug_list_spec_revisions',
    {
      title: 'List retained OpenSpec revisions',
      description:
        'Lists up to 50 content-addressed local OpenSpec revisions. Use plug_get_spec with revision to inspect one before explicitly replacing the current workflow.',
      annotations: local,
    },
    async (extra) => guarded(async () => listSpecRevisions(dir))({}, extra),
  );
  const resources: [string, string, string][] = [
    [
      specFiles.workflow,
      'application/yaml',
      'Open Workflow Specification document; the spec of record.',
    ],
    [specFiles.input, 'application/json', 'Canonical Plug DesignInput.'],
    [
      specFiles.design,
      'application/json',
      'DesignRecommendation for the input.',
    ],
    [
      specFiles.explanation,
      'text/markdown',
      'Explanation and implementation tasks.',
    ],
  ];
  for (const [name, mimeType, description] of resources)
    server.registerResource(
      name,
      `plug://spec/${name}`,
      { title: `.plug/${name}`, description, mimeType },
      async (uri) => {
        const path = join(specDir(dir), name);
        if (!existsSync(path))
          throw new Error(`.plug/${name} does not exist yet`);
        return {
          contents: [
            { uri: uri.href, mimeType, text: await readFile(path, 'utf8') },
          ],
        };
      },
    );
  server.registerResource(
    'manifest',
    'plug://manifest',
    {
      title: 'Authorized probe manifest',
      description:
        'Latest bounded local-workbench observations per operation; never production measurements or SLOs.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await readOperationManifests(dir), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    'verifications',
    'plug://verifications',
    {
      title: 'Edge demonstrations',
      description:
        'Bounded workbench demonstration records keyed by design and revision; not production verification.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await readVerificationRecords(dir), null, 2),
        },
      ],
    }),
  );
  return server;
}
export async function runMcpServer(workspaceDir: string, version?: string) {
  const server = createPlugMcpServer(workspaceDir, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
export type McpIde = 'cursor' | 'vscode' | 'claude' | 'generic';
export const mcpConfigFiles: Record<Exclude<McpIde, 'generic'>, string> = {
  cursor: '.cursor/mcp.json',
  vscode: '.vscode/mcp.json',
  claude: '.mcp.json',
};
export interface McpInstall {
  ide: McpIde;
  /** Workspace-relative config path; null for generic. */
  file: string | null;
  action: 'created' | 'updated' | 'unchanged' | 'printed';
  entry: { type?: 'stdio'; command: string; args: string[] };
  config: Record<string, unknown>;
}
/**
 * Registers `plug mcp` in project-scoped IDE configuration only. Other servers
 * are kept, and files that do not parse as JSON objects are never rewritten.
 */
export async function installMcp(
  workspaceDir: string,
  ide: McpIde,
  cliPath: string,
): Promise<McpInstall> {
  const dir = resolve(workspaceDir);
  const local = existsSync(join(dir, 'node_modules', '.bin', 'plug'));
  const workspaceArg =
    ide === 'cursor' || ide === 'vscode'
      ? ['--workspace', '${workspaceFolder}']
      : ide === 'generic'
        ? ['--workspace', dir]
        : [];
  const launch = local
    ? { command: 'npx', args: ['--no-install', 'plug', 'mcp', ...workspaceArg] }
    : {
        command: process.execPath,
        args: [resolve(cliPath), 'mcp', ...workspaceArg],
      };
  const entry =
    ide === 'cursor' ? launch : { type: 'stdio' as const, ...launch };
  const key = ide === 'vscode' ? 'servers' : 'mcpServers';
  if (ide === 'generic')
    return {
      ide,
      file: null,
      action: 'printed',
      entry,
      config: { mcpServers: { plug: entry } },
    };
  const file = mcpConfigFiles[ide];
  const path = join(dir, file);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = await readFile(path, 'utf8');
    try {
      config = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `${file} is not plain JSON; Plug will not rewrite it. Add the plug entry by hand or fix the file.`,
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error(
        `${file} is not a JSON object; Plug will not rewrite it.`,
      );
  }
  const servers = config[key] ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw new Error(
      `${file} ${key} is not an object; Plug will not rewrite it.`,
    );
  const previous = (servers as Record<string, unknown>).plug;
  if (JSON.stringify(previous) === JSON.stringify(entry))
    return { ide, file, action: 'unchanged', entry, config };
  const next = { ...config, [key]: { ...servers, plug: entry } };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2) + '\n');
  await rename(temp, path);
  return {
    ide,
    file,
    action: previous === undefined ? 'created' : 'updated',
    entry,
    config: next,
  };
}
