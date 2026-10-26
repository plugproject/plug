import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const gitTimeoutMs = 5000;
export const gitMaxBuffer = 1024 * 1024;
export const gitShaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface GitWorkflowCommit {
  sha: string;
  at: string;
  subject: string;
}

export interface GitWorkflowHistory {
  root: string;
  path: string;
  tracked: boolean;
  ignored: boolean;
  commits: GitWorkflowCommit[];
}

interface GitResult {
  code: number;
  stdout: string;
}

const gitEnvironment = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult | null> {
  if (signal?.aborted)
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError'),
    );
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        env: gitEnvironment,
        maxBuffer: gitMaxBuffer,
        signal,
        timeout: gitTimeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) {
          resolveResult({ code: 0, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'ABORT_ERR' ||
          error.name === 'AbortError' ||
          signal?.aborted
        ) {
          reject(error);
          return;
        }
        if (typeof code === 'number') {
          resolveResult({ code, stdout });
          return;
        }
        resolveResult(null);
      },
    );
  });
}

interface LocatedWorkflow {
  root: string;
  path: string;
}

async function locateWorkflow(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<LocatedWorkflow | null> {
  const workspace = await realpath(resolve(workspaceDir)).catch(() => null);
  if (!workspace) return null;
  const result = await runGit(
    workspace,
    ['rev-parse', '--show-toplevel'],
    signal,
  );
  if (!result || result.code !== 0) return null;
  const rawRoot = result.stdout.replace(/\r?\n$/, '');
  if (!rawRoot) return null;
  const root = await realpath(resolve(rawRoot)).catch(() => null);
  if (!root) return null;
  const path = relative(root, join(workspace, '.plug', 'workflow.yaml'))
    .split(sep)
    .join('/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path))
    return null;
  return { root, path };
}

/** Returns the containing repository root, or null outside Git. */
export async function findGitRoot(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return (await locateWorkflow(workspaceDir, signal))?.root ?? null;
}

function parseLog(text: string): GitWorkflowCommit[] | null {
  const commits: GitWorkflowCommit[] = [];
  const record = /([0-9a-f]{40}(?:[0-9a-f]{24})?)\0([^\0]*)\0([^\0]*)\0/g;
  for (const match of text.matchAll(record)) {
    const [, sha, at, subject] = match;
    if (!gitShaPattern.test(sha)) return null;
    commits.push({ sha, at, subject });
  }
  return text.trim().length > 0 && commits.length === 0 ? null : commits;
}

/**
 * Reads Git state and at most 50 commits for the workspace's workflow file.
 * This function never stages, commits, checks out or otherwise mutates Git.
 */
export async function readGitWorkflowHistory(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<GitWorkflowHistory | null> {
  const located = await locateWorkflow(workspaceDir, signal);
  if (!located) return null;
  const trackedResult = await runGit(
    located.root,
    ['ls-files', '--error-unmatch', '--', located.path],
    signal,
  );
  if (!trackedResult || ![0, 1].includes(trackedResult.code)) return null;
  const ignoredResult = await runGit(
    located.root,
    ['check-ignore', '-q', '--', located.path],
    signal,
  );
  if (!ignoredResult || ![0, 1].includes(ignoredResult.code)) return null;
  const tracked = trackedResult.code === 0;
  const ignored = ignoredResult.code === 0;
  let commits: GitWorkflowCommit[] = [];
  if (tracked) {
    const log = await runGit(
      located.root,
      ['log', '-n50', '--format=%H%x00%aI%x00%s%x00', '--', located.path],
      signal,
    );
    if (!log || log.code !== 0) return null;
    const parsed = parseLog(log.stdout);
    if (parsed === null) return null;
    commits = parsed;
  }
  return {
    root: located.root,
    path: located.path,
    tracked,
    ignored,
    commits,
  };
}

/** Reads the exact workflow file at a validated commit without changing Git. */
export async function readGitWorkflowRevision(
  workspaceDir: string,
  sha: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!gitShaPattern.test(sha)) throw new Error('Invalid Git commit ID');
  const located = await locateWorkflow(workspaceDir, signal);
  if (!located) return null;
  const shown = await runGit(
    located.root,
    ['show', '--no-ext-diff', '--no-textconv', `${sha}:${located.path}`, '--'],
    signal,
  );
  return shown?.code === 0 ? shown.stdout : null;
}

export const listGitRevisions = readGitWorkflowHistory;
export const readGitRevision = readGitWorkflowRevision;
