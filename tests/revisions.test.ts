import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flightInput } from '../packages/plug/src/demo/flight';
import {
  readSpecBundle,
  writeSpecBundle,
} from '../packages/plug/src/openspec/bundle';
import {
  listRevisions,
  readRevision,
} from '../packages/plug/src/openspec/revisions';
import {
  readGitWorkflowHistory,
  readGitWorkflowRevision,
} from '../packages/plug/src/workspace/git';

const temporaryDirectories: string[] = [];
const temporaryDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('OpenSpec revisions', () => {
  it('records exact workflow bytes, deduplicates, diffs and reports the current ID', async () => {
    const workspace = temporaryDirectory('plug-revisions-');
    const first = await writeSpecBundle(workspace, flightInput(), 'ui');
    const workflowPath = join(workspace, '.plug', 'workflow.yaml');
    const workflow = readFileSync(workflowPath, 'utf8');
    const expected = createHash('sha256').update(workflow).digest('hex');
    expect(first.revisionId).toBe(expected);
    expect(
      readFileSync(
        join(workspace, '.plug', 'revisions', `${expected}.yaml`),
        'utf8',
      ),
    ).toBe(workflow);
    expect(await readRevision(workspace, expected)).toBe(workflow);
    expect(
      readFileSync(join(workspace, '.plug', 'AGENTS.md'), 'utf8'),
    ).toContain(`revision \`${expected}\``);

    let revisions = await listRevisions(workspace);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: expected,
      source: 'ui',
      bytes: Buffer.byteLength(workflow),
      changedPaths: [],
    });

    await writeSpecBundle(workspace, flightInput(), 'mcp');
    revisions = await listRevisions(workspace);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].source).toBe('ui');

    const edited = flightInput();
    edited.connections[0].experience.latencyTargetMs += 1;
    const second = await writeSpecBundle(workspace, edited, 'probe');
    revisions = await listRevisions(workspace);
    expect(revisions.map((revision) => revision.id)).toEqual([
      second.revisionId,
      first.revisionId,
    ]);
    expect(revisions[0]).toMatchObject({
      source: 'probe',
      changedPaths: ['/connections/0/experience/latencyTargetMs'],
    });
    const state = await readSpecBundle(workspace);
    expect(state.currentRevisionId).toBe(second.revisionId);
    expect(state.summary?.revisionId).toBe(second.revisionId);
    expect(state.consistent).toBe(true);
    expect(
      readFileSync(join(workspace, '.plug', 'revisions.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(2);
    await expect(readRevision(workspace, '../workflow')).rejects.toThrow(
      /revision ID/,
    );
    writeFileSync(
      join(workspace, '.plug', 'revisions', `${second.revisionId}.yaml`),
      'tampered',
    );
    await expect(readRevision(workspace, second.revisionId)).rejects.toThrow(
      /hash mismatch/,
    );
  });

  it('does not record a revision when the five-file bundle write fails', async () => {
    const workspace = temporaryDirectory('plug-revision-failure-');
    mkdirSync(join(workspace, '.plug', 'AGENTS.md'), { recursive: true });
    await expect(writeSpecBundle(workspace, flightInput())).rejects.toThrow();
    expect(existsSync(join(workspace, '.plug', 'revisions'))).toBe(false);
    expect(existsSync(join(workspace, '.plug', 'revisions.jsonl'))).toBe(false);
  });

  it('retains the latest 50 unique snapshots and entries', async () => {
    const workspace = temporaryDirectory('plug-revision-retention-');
    const ids: string[] = [];
    for (let index = 0; index < 51; index++) {
      const input = flightInput();
      input.connections[0].experience.latencyTargetMs = 3000 + index;
      ids.push((await writeSpecBundle(workspace, input)).revisionId);
    }
    const revisions = await listRevisions(workspace);
    expect(revisions).toHaveLength(50);
    expect(revisions[0].id).toBe(ids[50]);
    expect(revisions.at(-1)?.id).toBe(ids[1]);
    expect(revisions.map((revision) => revision.id)).not.toContain(ids[0]);
    expect(
      readdirSync(join(workspace, '.plug', 'revisions')).filter((name) =>
        name.endsWith('.yaml'),
      ),
    ).toHaveLength(50);
    expect(await readRevision(workspace, ids[0])).toBeNull();
    expect(
      readFileSync(join(workspace, '.plug', 'revisions.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(50);
  }, 20_000);
});

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('read-only workflow Git history', () => {
  it('returns null outside a Git repository', async () => {
    expect(
      await readGitWorkflowHistory(
        temporaryDirectory('plug-revision-nonrepo-'),
      ),
    ).toBeNull();
  });

  it.skipIf(!gitAvailable)(
    'lists a tracked workflow and reads its exact committed bytes',
    async () => {
      const workspace = temporaryDirectory('plug-revision-git-');
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, '.plug'));
      const workflow = 'document:\n  dsl: 1.0.3\n# café\n';
      writeFileSync(join(workspace, '.plug', 'workflow.yaml'), workflow);
      execFileSync('git', ['add', '--', '.plug/workflow.yaml'], {
        cwd: workspace,
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Plug Test',
          '-c',
          'user.email=plug@example.invalid',
          'commit',
          '-q',
          '-m',
          'record workflow | safely',
        ],
        { cwd: workspace },
      );
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
        encoding: 'utf8',
      }).trim();
      const before = execFileSync('git', ['status', '--porcelain'], {
        cwd: workspace,
        encoding: 'utf8',
      });
      const history = await readGitWorkflowHistory(workspace);
      expect(history).toMatchObject({
        root: realpathSync(workspace),
        path: '.plug/workflow.yaml',
        tracked: true,
        ignored: false,
      });
      expect(history?.commits[0]).toMatchObject({
        sha,
        subject: 'record workflow | safely',
      });
      expect(await readGitWorkflowRevision(workspace, sha)).toBe(workflow);
      await expect(
        readGitWorkflowRevision(workspace, '../HEAD'),
      ).rejects.toThrow(/commit ID/);
      expect(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: workspace,
          encoding: 'utf8',
        }),
      ).toBe(before);
    },
  );
});
