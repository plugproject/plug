import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectPlugEnvironment,
  inspectWorkspaceEnvironment,
  setupPlugEnvironment,
  type PlugSetupPrompt,
} from '../packages/plug/src/environment';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class Answers implements PlugSetupPrompt {
  constructor(
    private readonly confirms: boolean[],
    private readonly selections: string[],
    private readonly inputs: string[],
  ) {}

  async confirm() {
    const answer = this.confirms.shift();
    if (answer === undefined) throw new Error('Unexpected confirmation');
    return answer;
  }

  async select() {
    const answer = this.selections.shift();
    if (answer === undefined) throw new Error('Unexpected selection');
    return answer;
  }

  async input() {
    const answer = this.inputs.shift();
    if (answer === undefined) throw new Error('Unexpected input');
    return answer;
  }
}

describe('Plug environment setup', () => {
  it('reports that core use is ready while optional providers are disabled', () => {
    expect(inspectPlugEnvironment({})).toEqual({
      core: { state: 'ready', required: [] },
      judgment: {
        state: 'disabled',
        provider: null,
        missing: [],
        issues: [],
      },
      drafting: {
        state: 'disabled',
        provider: null,
        missing: [],
        issues: [],
      },
      review: {
        state: 'disabled',
        provider: null,
        missing: [],
        issues: [],
      },
    });
  });

  it('names missing variables without exposing configured secret values', () => {
    const status = inspectPlugEnvironment({
      PLUG_JUDGE_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'private-judge-key',
      PLUG_DRAFT_PROVIDER: 'anthropic',
      PLUG_DRAFT_MODEL: 'draft-model',
    });
    expect(status.judgment).toMatchObject({
      state: 'incomplete',
      provider: 'typesafe',
      missing: ['PLUG_JUDGE_MODEL'],
    });
    expect(status.drafting).toMatchObject({
      state: 'incomplete',
      provider: 'anthropic',
      missing: ['ANTHROPIC_API_KEY'],
    });
    expect(JSON.stringify(status)).not.toContain('private-judge-key');
  });

  it('prompts for optional providers and writes an ignored mode-600 file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plug-environment-'));
    roots.push(root);
    const result = await setupPlugEnvironment({
      workspace: root,
      env: {},
      prompt: new Answers(
        [true, true, true],
        ['anthropic'],
        [
          'typesafe-secret',
          'jev-model',
          'anthropic-secret',
          'draft-model',
          'review-model',
        ],
      ),
    });
    expect(result.action).toBe('created');
    expect(result.gitignore).toBe('updated');
    expect(result.status.judgment.state).toBe('ready');
    expect(result.status.drafting.state).toBe('ready');
    expect(result.status.review.state).toBe('ready');
    expect(result).not.toHaveProperty('values');
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain(
      '.env.local',
    );
    const local = await readFile(join(root, '.env.local'), 'utf8');
    expect(local).toContain('PLUG_JUDGE_PROVIDER="typesafe"');
    expect(local).toContain('TYPESAFE_API_KEY="typesafe-secret"');
    expect(local).toContain('PLUG_DRAFT_PROVIDER="anthropic"');
    expect(local).toContain('PLUG_REVIEW_MODEL="review-model"');
    expect((await stat(join(root, '.env.local'))).mode & 0o777).toBe(0o600);
    expect(inspectWorkspaceEnvironment(root, {}).review.state).toBe('ready');
  });

  it('leaves a complete workspace configuration unchanged without prompting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plug-environment-ready-'));
    roots.push(root);
    await writeFile(join(root, '.gitignore'), '.env*\n');
    const configured = [
      'PLUG_JUDGE_PROVIDER=typesafe',
      'TYPESAFE_API_KEY=judge-key',
      'PLUG_JUDGE_MODEL=judge-model',
      'PLUG_DRAFT_PROVIDER=openai',
      'OPENAI_API_KEY=draft-key',
      'PLUG_DRAFT_MODEL=draft-model',
    ].join('\n');
    await writeFile(join(root, '.env.local'), `${configured}\n`);
    const unexpected = async () => {
      throw new Error('A complete setup must not prompt');
    };
    const result = await setupPlugEnvironment({
      workspace: root,
      env: {},
      prompt: {
        confirm: unexpected,
        select: unexpected,
        input: unexpected,
      },
    });
    expect(result.action).toBe('unchanged');
    expect(result.written).toEqual([]);
    expect(await readFile(join(root, '.env.local'), 'utf8')).toBe(
      `${configured}\n`,
    );
  });

  it('refuses to store credentials when the workspace will not ignore them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plug-environment-refused-'));
    roots.push(root);
    await expect(
      setupPlugEnvironment({
        workspace: root,
        env: {},
        prompt: new Answers([true, false], [], []),
      }),
    ).rejects.toThrow(/not ignored/);
    await expect(readFile(join(root, '.env.local'), 'utf8')).rejects.toThrow();
  });
});
