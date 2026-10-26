import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type SkillIde = 'cursor' | 'vscode' | 'claude' | 'generic';
export interface SkillInstall {
  ide: SkillIde;
  directory: string;
  action: 'created' | 'updated' | 'unchanged';
}
const locations: Record<SkillIde, string> = {
  cursor: '.agents/skills/plug',
  generic: '.agents/skills/plug',
  claude: '.claude/skills/plug',
  vscode: '.github/skills/plug',
};

async function contents(dir: string): Promise<Record<string, string>> {
  if (!existsSync(dir)) return {};
  const result: Record<string, string> = {};
  const walk = async (path: string, prefix = '') => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else result[relative] = await readFile(absolute, 'utf8');
    }
  };
  await walk(dir);
  return result;
}

/** Installs Plug's portable Agent Skill without changing any IDE user config. */
export async function installSkill(
  workspaceDir: string,
  ide: SkillIde,
  sourceDir: string,
): Promise<SkillInstall> {
  const source = resolve(sourceDir);
  if (!existsSync(join(source, 'SKILL.md')))
    throw new Error('Packaged Plug skill is missing SKILL.md');
  const relative = locations[ide];
  const target = join(resolve(workspaceDir), relative);
  const before = await contents(target);
  const after = await contents(source);
  if (JSON.stringify(before) === JSON.stringify(after))
    return { ide, directory: relative, action: 'unchanged' };
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const backup = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.bak`;
  await rm(temporary, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  const existed = existsSync(target);
  try {
    await cp(source, temporary, { recursive: true, force: false });
    if (existed) await rename(target, backup);
    await rename(temporary, target);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (existed && existsSync(backup) && !existsSync(target))
      await rename(backup, target);
    throw error;
  }
  return {
    ide,
    directory: relative,
    action: Object.keys(before).length ? 'updated' : 'created',
  };
}
