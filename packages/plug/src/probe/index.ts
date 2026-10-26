import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OperationManifest } from '../contracts/index';
import { isCacheHeader, isRateLimitHeader } from './run';
import { operationManifestHash } from './summarize';

export * from './apply';
export * from './hosts';
export * from './plan';
export * from './questions';
export * from './run';
export * from './samples';
export * from './summarize';

const manifestPath = (workspace: string) =>
  join(workspace, '.plug', 'manifest.json');

export class ProbeManifestStoreError extends Error {}

function looksLikeManifest(value: unknown): value is OperationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<OperationManifest>;
  return (
    row.formatVersion === '0.2-alpha.1' &&
    typeof row.manifestHash === 'string' &&
    typeof row.systemId === 'string' &&
    typeof row.operationId === 'string' &&
    typeof row.endpoint === 'string' &&
    typeof row.measuredAt === 'string' &&
    Number.isFinite(Date.parse(row.measuredAt)) &&
    typeof row.sampleSize === 'number' &&
    Number.isFinite(row.sampleSize) &&
    row.sampleSize >= 0 &&
    !!row.latencyMs &&
    !!row.statusHistogram &&
    !!row.rateLimitHeaders &&
    !!row.cacheHeaders &&
    Array.isArray(row.timestampCandidates)
  );
}

function safeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProbeManifestStoreError(
      'A probe manifest has an invalid endpoint.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ProbeManifestStoreError(
      'Probe manifest endpoints must use http or https.',
    );
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function safeHeaderMap(
  headers: Record<string, string>,
  predicate: (name: string) => boolean,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!predicate(name))
      throw new ProbeManifestStoreError(
        `Unsafe response header ${name} cannot be stored in a probe manifest.`,
      );
    safe[name.toLowerCase()] = String(value)
      .replace(/[\r\n]/g, '')
      .slice(0, 2_048);
  }
  return Object.fromEntries(
    Object.entries(safe).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizedManifest(manifest: OperationManifest): OperationManifest {
  const content: Omit<OperationManifest, 'manifestHash'> = {
    ...structuredClone(manifest),
    endpoint: safeEndpoint(manifest.endpoint),
    rateLimitHeaders: safeHeaderMap(
      manifest.rateLimitHeaders,
      isRateLimitHeader,
    ),
    cacheHeaders: safeHeaderMap(manifest.cacheHeaders, isCacheHeader),
  };
  const { manifestHash: _discarded, ...withoutHash } =
    content as OperationManifest;
  return {
    ...withoutHash,
    manifestHash: operationManifestHash(withoutHash),
  };
}

function latestAndOrdered(
  manifests: readonly OperationManifest[],
): OperationManifest[] {
  const latest = new Map<string, OperationManifest>();
  for (const value of manifests) {
    const manifest = normalizedManifest(value);
    const key = `${manifest.systemId}\u0000${manifest.operationId}`;
    const previous = latest.get(key);
    if (
      !previous ||
      Date.parse(manifest.measuredAt) >= Date.parse(previous.measuredAt)
    )
      latest.set(key, manifest);
  }
  return [...latest.values()].sort(
    (a, b) =>
      a.systemId.localeCompare(b.systemId) ||
      a.operationId.localeCompare(b.operationId),
  );
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readOperationManifests(
  workspace: string,
): Promise<OperationManifest[]> {
  let text: string;
  try {
    text = await readFile(manifestPath(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProbeManifestStoreError('.plug/manifest.json is not valid JSON.');
  }
  const rows = Array.isArray(value)
    ? value
    : (value as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(rows) || !rows.every(looksLikeManifest))
    throw new ProbeManifestStoreError(
      '.plug/manifest.json must contain operation manifests.',
    );
  return latestAndOrdered(rows);
}

export async function writeOperationManifests(
  workspace: string,
  manifests: readonly OperationManifest[],
): Promise<OperationManifest[]> {
  const ordered = latestAndOrdered(manifests);
  await atomicWrite(manifestPath(workspace), ordered);
  return ordered;
}

export async function upsertOperationManifest(
  workspace: string,
  manifest: OperationManifest,
): Promise<OperationManifest[]> {
  const existing = await readOperationManifests(workspace);
  return writeOperationManifests(workspace, [...existing, manifest]);
}

export const readProbeManifest = readOperationManifests;
export const writeProbeManifest = writeOperationManifests;

export * from './orchestrate';
