import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installMcp } from '../packages/plug/src/mcp/server';
import { flightInput } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
let workspace: string, client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = r.content[0].text;
  return { error: !!r.isError, text, json: () => JSON.parse(text) };
};
beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'plug-mcp-'));
  writeFileSync(
    join(workspace, 'openapi.json'),
    JSON.stringify({
      openapi: '3.1.0',
      paths: { '/items': { get: { operationId: 'listItems' } } },
    }),
  );
  client = new Client({ name: 'plug-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        resolve('packages/plug/src/cli.ts'),
        'mcp',
        '--workspace',
        workspace,
      ],
      cwd: resolve('.'),
      stderr: 'pipe',
    }),
  );
}, 30000);
afterAll(async () => {
  await client?.close();
  rmSync(workspace, { recursive: true, force: true });
});
describe('Plug MCP server over stdio', () => {
  it('lists its tools and resources', async () => {
    expect(client.getServerVersion()?.name).toBe('plug');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'plug_add_system',
      'plug_adopt_design',
      'plug_analyze',
      'plug_explain',
      'plug_get_spec',
      'plug_index_workspace',
      'plug_list_spec_revisions',
      'plug_probe',
      'plug_review_design',
      'plug_update_spec',
      'plug_verify_edge',
    ]);
    expect(
      tools.find((t) => t.name === 'plug_get_spec')?.annotations?.readOnlyHint,
    ).toBe(true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('plug://spec/workflow.yaml');
    expect(resources.map((r) => r.uri)).toContain('plug://manifest');
    expect(resources.map((r) => r.uri)).toContain('plug://verifications');
  });
  it('reads, updates and re-reads the spec of record', async () => {
    const empty = (await call('plug_get_spec')).json();
    expect(empty.present).toBe(false);
    expect(empty.next).toMatch(/plug_update_spec/);
    const updated = await call('plug_update_spec', { input: flightInput() });
    expect(updated.error).toBe(false);
    const written = updated.json();
    expect(written.designHash).toBe(suggestDesign(flightInput()).designHash);
    expect(written.connections[0]).toMatchObject({
      connectionId: 'primary',
      selectedArchitectureId: 'scheduled-cache',
    });
    expect(written.connections[0].tasks.length).toBeGreaterThan(0);
    expect(existsSync(join(workspace, '.plug', 'AGENTS.md'))).toBe(true);
    const historical = (
      await call('plug_get_spec', {
        revision: written.revisionId,
        include: ['workflow'],
      })
    ).json();
    expect(historical.files['workflow.yaml']).toContain('dsl: 1.0.3');
    expect(historical.files.workflow).toBeUndefined();
    const spec = (
      await call('plug_get_spec', { include: ['workflow'] })
    ).json();
    expect(spec).toMatchObject({ present: true, consistent: true });
    expect(spec.files['workflow.yaml']).toContain('dsl: 1.0.3');
    const resource = await client.readResource({
      uri: 'plug://spec/workflow.yaml',
    });
    const content = resource.contents[0];
    const workflow = 'text' in content ? content.text : '';
    expect(workflow).toBe(spec.files['workflow.yaml']);
    const at = workflow.lastIndexOf('latencyTargetMs: 2000');
    const edited =
      workflow.slice(0, at) + 'latencyTargetMs: 1500' + workflow.slice(at + 21);
    const designFile = join(workspace, '.plug', 'design.json');
    const before = statSync(designFile).mtimeMs;
    const analyzed = (await call('plug_analyze', { workflow: edited })).json();
    expect(analyzed.lossless).toBe(false);
    expect(analyzed.connections[0].experience.latencyTargetMs).toBe(1500);
    expect(statSync(designFile).mtimeMs).toBe(before);
    const applied = (
      await call('plug_update_spec', { workflow: edited })
    ).json();
    expect(applied.gaps.join()).toMatch(/1500 ms/);
    expect(
      JSON.parse(
        readFileSync(join(workspace, '.plug', 'design-input.json'), 'utf8'),
      ).connections[0].experience.latencyTargetMs,
    ).toBe(1500);
    const explained = await call('plug_explain', { connectionId: 'primary' });
    expect(explained.text).toContain('# Connection primary');
    expect((await call('plug_explain', { connectionId: 'nope' })).error).toBe(
      true,
    );
  });
  it('rejects ambiguous, invalid and oversized updates without writing', async () => {
    const file = join(workspace, '.plug', 'design-input.json');
    const before = readFileSync(file, 'utf8');
    expect((await call('plug_update_spec', {})).error).toBe(true);
    expect(
      (
        await call('plug_update_spec', {
          input: flightInput(),
          workflow: 'x: 1',
        })
      ).error,
    ).toBe(true);
    const invalid = await call('plug_update_spec', {
      input: { formatVersion: '0.2-alpha.1' },
    });
    expect(invalid.error).toBe(true);
    const big = await call('plug_update_spec', {
      input: { ...flightInput(), padding: 'x'.repeat(300 * 1024) },
    });
    expect(big.error).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('indexes the workspace locally', async () => {
    const indexed = (await call('plug_index_workspace')).json();
    expect(indexed.file).toBe('.plug/workspace-index.json');
    expect(indexed.system.operations).toContain('listitems');
    expect(existsSync(join(workspace, '.plug', 'workspace-index.json'))).toBe(
      true,
    );
  });
});
describe('plug mcp install', () => {
  const cli = resolve('packages/plug/dist/cli.js');
  it('merges a project-scoped Cursor entry and keeps other servers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-install-'));
    mkdirSync(join(dir, '.cursor'));
    const path = join(dir, '.cursor', 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { command: 'other-server' } },
        extra: true,
      }),
    );
    const first = await installMcp(dir, 'cursor', cli);
    expect(first).toMatchObject({
      file: '.cursor/mcp.json',
      action: 'created',
    });
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.extra).toBe(true);
    expect(config.mcpServers.other).toEqual({ command: 'other-server' });
    expect(config.mcpServers.plug.args).toEqual([
      cli,
      'mcp',
      '--workspace',
      '${workspaceFolder}',
    ]);
    expect((await installMcp(dir, 'cursor', cli)).action).toBe('unchanged');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'plug'), '');
    const local = await installMcp(dir, 'cursor', cli);
    expect(local.action).toBe('updated');
    expect(local.entry).toEqual({
      command: 'npx',
      args: [
        '--no-install',
        'plug',
        'mcp',
        '--workspace',
        '${workspaceFolder}',
      ],
    });
    rmSync(dir, { recursive: true, force: true });
  });
  it('writes VS Code and Claude layouts, prints generic, refuses unparseable files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-install-'));
    const vscode = await installMcp(dir, 'vscode', cli);
    expect(
      JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8')).servers
        .plug,
    ).toMatchObject({ type: 'stdio' });
    expect(vscode.file).toBe('.vscode/mcp.json');
    const claude = await installMcp(dir, 'claude', cli);
    expect(claude.entry.args).toEqual([cli, 'mcp']);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    const generic = await installMcp(dir, 'generic', cli);
    expect(generic).toMatchObject({ action: 'printed', file: null });
    expect(generic.entry.args).toContain(dir);
    mkdirSync(join(dir, '.cursor'));
    const broken = join(dir, '.cursor', 'mcp.json');
    writeFileSync(broken, '{ // comment\n}');
    await expect(installMcp(dir, 'cursor', cli)).rejects.toThrow(
      /will not rewrite/,
    );
    expect(readFileSync(broken, 'utf8')).toBe('{ // comment\n}');
    rmSync(dir, { recursive: true, force: true });
  });
});
