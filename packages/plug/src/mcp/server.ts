import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseInput } from '../contracts/index';
import type { DesignInput, DesignRecommendation } from '../contracts/index';
import { writeWorkspaceIndex } from '../indexer/index';
import {
  readSpecBundle,
  specDir,
  specFiles,
  summarize,
  writeSpecBundle,
} from '../openspec/bundle';
import { readSpecSource } from '../openspec/index';
import { explainDesign, suggestDesign } from '../recommender/index';
const argumentLimit = 256 * 1024;
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
        throw new Error('Tool arguments exceed 256 KB');
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
/** What a coding agent needs per connection without reading the full report. */
function brief(input: DesignInput, design: DesignRecommendation) {
  return summarize(input, design).connections.map((s) => {
    const c = input.connections.find((x) => x.id === s.connectionId)!;
    const r = design.connections.find(
      (x) => x.connectionId === s.connectionId,
    )!;
    const a = r.architectures.find((x) => x.id === r.selectedArchitectureId);
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
    };
  });
}
/** Plug itself as an MCP server for one workspace. Never invokes described endpoints. */
export function createPlugMcpServer(workspaceDir: string, version = '0.2.0') {
  const dir = resolve(workspaceDir);
  const server = new McpServer(
    { name: 'plug', version },
    {
      instructions:
        'Plug keeps the integration spec of this workspace in .plug/. Read it with plug_get_spec before changing how this project calls other systems; after such a change, record it with plug_update_spec. Unknown facts stay unknown; never invent latency, quota or cache permission.',
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
      },
      annotations: local,
    },
    guarded(async ({ include = [] }: { include?: string[] }) => {
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
        connections:
          state.input && state.design ? brief(state.input, state.design) : [],
        crossConnection: state.design?.crossConnection ?? [],
        files,
      };
    }),
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
      const written = await writeSpecBundle(dir, sourceOf(args));
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
