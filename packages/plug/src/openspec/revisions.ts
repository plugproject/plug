import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DesignInput, DesignRecommendation } from '../contracts/index';

export const revisionLimit = 50;
export const changedPathLimit = 100;
const changedPathByteLimit = 512;
const revisionLogByteLimit = 32 * 1024 * 1024;
const revisionByteLimit = 64 * 1024 * 1024;
export const revisionIdPattern = /^[0-9a-f]{64}$/;

export type RevisionSource = 'ui' | 'mcp' | 'cli' | 'probe' | 'adopt';

export interface SpecRevision {
  id: string;
  at: string;
  inputHash: string;
  designHash: string;
  catalogVersion: string;
  source: RevisionSource;
  bytes: number;
  changedPaths: string[];
}

const revisionSources = new Set<RevisionSource>([
  'ui',
  'mcp',
  'cli',
  'probe',
  'adopt',
]);

const plugDir = (workspaceDir: string) => join(resolve(workspaceDir), '.plug');
const revisionsDir = (workspaceDir: string) =>
  join(plugDir(workspaceDir), 'revisions');
const logPath = (workspaceDir: string) =>
  join(plugDir(workspaceDir), 'revisions.jsonl');

export function validateRevisionSource(source: unknown): RevisionSource {
  if (
    typeof source !== 'string' ||
    !revisionSources.has(source as RevisionSource)
  )
    throw new Error('Invalid spec revision source');
  return source as RevisionSource;
}

export function revisionId(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const revisionIdFor = revisionId;

function validateRevisionId(id: string): void {
  if (!revisionIdPattern.test(id)) throw new Error('Invalid spec revision ID');
}

const pointerPart = (part: string) =>
  part.replaceAll('~', '~0').replaceAll('/', '~1');

function childPath(path: string, part: string): string | null {
  const child = `${path}/${pointerPart(part)}`;
  return Buffer.byteLength(child) <= changedPathByteLimit ? child : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic, bounded JSON Pointer paths changed between canonical inputs. */
export function changedCanonicalPaths(
  previous: DesignInput | null,
  next: DesignInput,
): string[] {
  if (previous === null) return [];
  const paths = new Set<string>();
  const add = (path: string) => {
    if (paths.size < changedPathLimit) paths.add(path || '/');
  };
  const walk = (before: unknown, after: unknown, path: string): void => {
    if (paths.size >= changedPathLimit || Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length);
      for (let i = 0; i < length && paths.size < changedPathLimit; i++) {
        const child = childPath(path, String(i));
        if (child === null) {
          add(path);
          continue;
        }
        if (i >= before.length || i >= after.length) add(child);
        else walk(before[i], after[i], child);
      }
      return;
    }
    if (isRecord(before) && isRecord(after)) {
      const keys = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].sort();
      for (const key of keys) {
        if (paths.size >= changedPathLimit) break;
        const child = childPath(path, key);
        if (child === null) {
          add(path);
          continue;
        }
        if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key))
          add(child);
        else walk(before[key], after[key], child);
      }
      return;
    }
    add(path);
  };
  walk(previous, next, '');
  return [...paths].sort();
}

function invalidLog(): never {
  throw new Error('Invalid spec revision log');
}

function parseEntry(value: unknown): SpecRevision {
  if (!isRecord(value)) return invalidLog();
  const {
    id,
    at,
    inputHash,
    designHash,
    catalogVersion,
    source,
    bytes,
    changedPaths,
  } = value;
  if (
    typeof id !== 'string' ||
    !revisionIdPattern.test(id) ||
    typeof at !== 'string' ||
    !Number.isFinite(Date.parse(at)) ||
    typeof inputHash !== 'string' ||
    !revisionIdPattern.test(inputHash) ||
    typeof designHash !== 'string' ||
    !revisionIdPattern.test(designHash) ||
    typeof catalogVersion !== 'string' ||
    !catalogVersion ||
    typeof source !== 'string' ||
    !revisionSources.has(source as RevisionSource) ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Array.isArray(changedPaths) ||
    changedPaths.length > changedPathLimit ||
    changedPaths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        Buffer.byteLength(path) > changedPathByteLimit,
    )
  )
    return invalidLog();
  return {
    id,
    at,
    inputHash,
    designHash,
    catalogVersion,
    source: source as RevisionSource,
    bytes,
    changedPaths: [...changedPaths] as string[],
  };
}

async function readEntries(workspaceDir: string): Promise<SpecRevision[]> {
  let text: string;
  try {
    text = await readFile(logPath(workspaceDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (Buffer.byteLength(text) > revisionLogByteLimit)
    throw new Error('Spec revision log exceeds 32 MiB');
  const entries = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return parseEntry(JSON.parse(line));
      } catch (error) {
        if ((error as Error).message === 'Invalid spec revision log')
          throw error;
        return invalidLog();
      }
    });
  const deduped = new Map<string, SpecRevision>();
  for (const entry of entries) {
    deduped.delete(entry.id);
    deduped.set(entry.id, entry);
  }
  return [...deduped.values()].slice(-revisionLimit);
}

async function atomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function ensureRevisionDirectory(workspaceDir: string): Promise<string> {
  const directory = revisionsDir(workspaceDir);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Spec revision directory must be a directory');
  return directory;
}

async function readSnapshot(
  workspaceDir: string,
  id: string,
): Promise<string | null> {
  validateRevisionId(id);
  const directory = revisionsDir(workspaceDir);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error('Spec revision directory must be a directory');
  const path = join(directory, `${id}.yaml`);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Spec revision snapshot must be a regular file');
  if (info.size > revisionByteLimit)
    throw new Error('Spec revision snapshot exceeds 64 MB');
  const bytes = await readFile(path);
  if (revisionId(bytes) !== id)
    throw new Error('Spec revision snapshot hash mismatch');
  return bytes.toString('utf8');
}

async function writeSnapshot(
  workspaceDir: string,
  id: string,
  workflow: string,
): Promise<boolean> {
  const directory = await ensureRevisionDirectory(workspaceDir);
  const existing = await readSnapshot(workspaceDir, id);
  if (existing !== null) {
    if (existing !== workflow)
      throw new Error('Spec revision snapshot content mismatch');
    return false;
  }
  const path = join(directory, `${id}.yaml`);
  const temp = join(
    directory,
    `.${id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, workflow, { flag: 'wx' });
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await readSnapshot(workspaceDir, id);
      if (raced !== workflow)
        throw new Error('Spec revision snapshot content mismatch', {
          cause: error,
        });
      return false;
    }
  } finally {
    await rm(temp, { force: true });
  }
}

function encodeEntries(entries: SpecRevision[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

export async function recordRevision(
  workspaceDir: string,
  workflow: string,
  previousInput: DesignInput | null,
  nextInput: DesignInput,
  design: Pick<
    DesignRecommendation,
    'inputHash' | 'designHash' | 'catalogVersion'
  >,
  rawSource: RevisionSource,
): Promise<SpecRevision> {
  const source = validateRevisionSource(rawSource);
  const id = revisionId(workflow);
  const entries = await readEntries(workspaceDir);
  const duplicate = entries.find((entry) => entry.id === id);
  if (duplicate) {
    await writeSnapshot(workspaceDir, id, workflow);
    return duplicate;
  }
  const entry: SpecRevision = {
    id,
    at: new Date().toISOString(),
    inputHash: design.inputHash,
    designHash: design.designHash,
    catalogVersion: design.catalogVersion,
    source,
    bytes: Buffer.byteLength(workflow),
    changedPaths: changedCanonicalPaths(previousInput, nextInput),
  };
  const all = [...entries, entry];
  const kept = all.slice(-revisionLimit);
  const dropped = all.slice(0, -revisionLimit);
  const created = await writeSnapshot(workspaceDir, id, workflow);
  try {
    await atomic(logPath(workspaceDir), encodeEntries(kept));
  } catch (error) {
    if (created)
      await rm(join(revisionsDir(workspaceDir), `${id}.yaml`), { force: true });
    throw error;
  }
  await Promise.all(
    dropped.map((old) =>
      rm(join(revisionsDir(workspaceDir), `${old.id}.yaml`), { force: true }),
    ),
  );
  return entry;
}

/** Lists retained revisions newest first. */
export async function listRevisions(
  workspaceDir: string,
): Promise<SpecRevision[]> {
  return (await readEntries(workspaceDir))
    .reverse()
    .map((entry) => ({ ...entry, changedPaths: [...entry.changedPaths] }));
}

/** Reads and hash-verifies an exact retained workflow snapshot. */
export async function readRevision(
  workspaceDir: string,
  id: string,
): Promise<string | null> {
  return readSnapshot(workspaceDir, id);
}

export const listSpecRevisions = listRevisions;
export const readSpecRevision = readRevision;
