import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installSkill,
  type SkillIde,
} from '../packages/plug/src/skill/install';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});
const source = resolve('packages/plug/skill/plug');
const targetFor = (root: string, ide: SkillIde) =>
  join(
    root,
    ide === 'claude'
      ? '.claude/skills/plug'
      : ide === 'vscode'
        ? '.github/skills/plug'
        : '.agents/skills/plug',
  );

describe('portable Plug skill installer', () => {
  it('installs into each project-scoped Agent Skills location', async () => {
    for (const ide of ['cursor', 'vscode', 'claude', 'generic'] as const) {
      const root = await mkdtemp(join(tmpdir(), `plug-skill-${ide}-`));
      roots.push(root);
      const result = await installSkill(root, ide, source);
      expect(result.action).toBe('created');
      expect(
        await readFile(join(targetFor(root, ide), 'SKILL.md'), 'utf8'),
      ).toContain('name: plug');
      expect((await installSkill(root, ide, source)).action).toBe('unchanged');
    }
  });

  it('replaces a changed Plug skill while keeping the source authoritative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plug-skill-update-'));
    roots.push(root);
    await installSkill(root, 'cursor', source);
    const target = targetFor(root, 'cursor');
    await writeFile(join(target, 'SKILL.md'), 'changed\n');
    expect((await installSkill(root, 'cursor', source)).action).toBe('updated');
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain(
      'Treat `.plug/workflow.yaml`',
    );
  });
});
