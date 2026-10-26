import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuthorizedHost } from '../contracts/index';

const storePath = (workspace: string) => join(workspace, '.plug', 'hosts.json');
const isoDateTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class HostAuthorizationError extends Error {}

/**
 * Turns an HTTP(S) URL into the exact origin used as the authorization
 * boundary. Credentials, paths, queries and fragments are intentionally not
 * part of that boundary.
 */
export function canonicalOrigin(value: string | URL): string {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value.trim());
  } catch {
    throw new HostAuthorizationError('Host authorization needs a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new HostAuthorizationError(
      'Only http and https origins can be authorized.',
    );
  if (!parsed.hostname)
    throw new HostAuthorizationError('Host authorization needs a hostname.');
  parsed.username = '';
  parsed.password = '';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.origin;
}

function isAuthorizedHost(value: unknown): value is AuthorizedHost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.host !== 'string' ||
    typeof row.addedAt !== 'string' ||
    !['ui', 'mcp', 'cli'].includes(String(row.addedVia)) ||
    !isoDateTime.test(row.addedAt) ||
    !Number.isFinite(Date.parse(row.addedAt))
  )
    return false;
  try {
    return canonicalOrigin(row.host) === row.host;
  } catch {
    return false;
  }
}

const ordered = (hosts: AuthorizedHost[]) =>
  [...new Map(hosts.map((host) => [host.host, host])).values()].sort((a, b) =>
    a.host.localeCompare(b.host),
  );

async function atomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
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

export async function readAuthorizedHosts(
  workspace: string,
): Promise<AuthorizedHost[]> {
  let text: string;
  try {
    text = await readFile(storePath(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HostAuthorizationError('.plug/hosts.json is not valid JSON.');
  }
  const rows = Array.isArray(value)
    ? value
    : (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(rows) || !rows.every(isAuthorizedHost))
    throw new HostAuthorizationError(
      '.plug/hosts.json must contain canonical authorized hosts.',
    );
  return ordered(rows);
}

export async function writeAuthorizedHosts(
  workspace: string,
  hosts: AuthorizedHost[],
): Promise<void> {
  if (!hosts.every(isAuthorizedHost))
    throw new HostAuthorizationError(
      'Authorized hosts must contain canonical origins and valid provenance.',
    );
  await atomicJson(storePath(workspace), ordered(hosts));
}

export async function addAuthorizedHost(
  workspace: string,
  value: string | URL,
  addedVia: AuthorizedHost['addedVia'],
  addedAt = new Date().toISOString(),
): Promise<AuthorizedHost> {
  if (!isoDateTime.test(addedAt) || !Number.isFinite(Date.parse(addedAt)))
    throw new HostAuthorizationError('addedAt must be an ISO date-time.');
  const host = canonicalOrigin(value);
  const hosts = await readAuthorizedHosts(workspace);
  const existing = hosts.find((row) => row.host === host);
  if (existing) return existing;
  const added: AuthorizedHost = { host, addedAt, addedVia };
  await writeAuthorizedHosts(workspace, [...hosts, added]);
  return added;
}

export function originIsAuthorized(
  value: string | URL,
  hosts: readonly AuthorizedHost[],
): boolean {
  const origin = canonicalOrigin(value);
  return hosts.some((row) => row.host === origin);
}

export async function assertAuthorizedOrigin(
  workspace: string,
  value: string | URL,
  suppliedHosts?: readonly AuthorizedHost[],
): Promise<string> {
  const origin = canonicalOrigin(value);
  const hosts = suppliedHosts ?? (await readAuthorizedHosts(workspace));
  if (!hosts.some((row) => row.host === origin))
    throw new HostAuthorizationError(
      `Origin ${origin} is not authorized in .plug/hosts.json.`,
    );
  return origin;
}
