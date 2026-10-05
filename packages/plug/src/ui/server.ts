import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  assertContract,
  parseInput,
  selectedOperation,
} from '../contracts/index';
import type { DemoEvent, WorkspaceIndex } from '../contracts/index';
import { coldKey, flightInput, keys } from '../demo/flight';
import { startFixture } from '../demo/fixture';
import { runDemo } from '../demo/runtime';
import {
  DiscoveryError,
  discover,
  parseDiscoveryRequest,
} from '../discovery/index';
import {
  indexWorkspace,
  workspaceIndexFile,
  writeWorkspaceIndex,
} from '../indexer/index';
import { readSpecBundle, writeSpecBundle } from '../openspec/bundle';
import { explainDesign, suggestDesign } from '../recommender/index';
export interface UiServerOptions {
  port?: number;
  workspaceDir?: string;
  uiDir?: string;
  fixtureLatencyMs?: number;
  lifetimeMs?: number;
}
const bodyLimit = 256 * 1024;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
};
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > bodyLimit)
      throw new HttpError(413, 'Description exceeds 256 KB');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }
  if (/^(text\/plain|application\/yaml|text\/yaml)/.test(type))
    return parseInput(text);
  throw new HttpError(415, 'Use application/json or YAML');
}
const defaultUiDir = () =>
  resolve(dirname(fileURLToPath(import.meta.url)), 'ui');
/** Local workbench: loopback only, single sandbox, workspace endpoints scoped to one directory. */
export async function startUiServer(options: UiServerOptions = {}) {
  const workspaceDir = resolve(options.workspaceDir ?? process.cwd());
  const uiDir = resolve(options.uiDir ?? defaultUiDir());
  const indexFile = workspaceIndexFile(workspaceDir);
  let session: {
    id: string;
    token: string;
    actions: number;
    send: (event: DemoEvent) => void;
    runner: ReturnType<typeof runDemo>;
    fixture: Awaited<ReturnType<typeof startFixture>>;
  } | null = null;
  let starting = false;
  let indexing: AbortController | null = null;
  let discovering: AbortController | null = null;
  let port = 0;
  const readStored = async (): Promise<WorkspaceIndex | null> => {
    if (!existsSync(indexFile)) return null;
    try {
      const value = JSON.parse(await readFile(indexFile, 'utf8'));
      assertContract<WorkspaceIndex>('WorkspaceIndex', value);
      return value;
    } catch {
      return null;
    }
  };
  const routes: Record<
    string,
    (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  > = {
    'GET /api/examples': (_req, res) =>
      json(res, 200, { flight: flightInput() }),
    'POST /api/analyze': async (req, res) => {
      const report = suggestDesign(await readBody(req));
      json(res, 200, { report, markdown: explainDesign(report) });
    },
    'GET /api/workspace': async (req, res) => {
      const stored = await readStored();
      let fresh: boolean | null = null;
      if (stored) {
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        const current = await indexWorkspace(workspaceDir, {
          signal: controller.signal,
        });
        fresh =
          current.fingerprint === stored.fingerprint &&
          current.indexerVersion === stored.indexerVersion;
      }
      const spec = await readSpecBundle(workspaceDir);
      json(res, 200, {
        workspace: basename(workspaceDir),
        indexed: !!stored,
        fresh,
        index: stored,
        spec: {
          present: spec.present,
          consistent: spec.consistent,
          workflowEdited: spec.workflowEdited,
          problems: spec.problems,
          summary: spec.summary,
        },
      });
    },
    'GET /api/workspace/spec': async (_req, res) => {
      const spec = await readSpecBundle(workspaceDir);
      json(res, 200, {
        present: spec.present,
        consistent: spec.consistent,
        workflowEdited: spec.workflowEdited,
        problems: spec.problems,
        workflow: spec.workflow,
      });
    },
    'POST /api/workspace/spec': async (req, res) => {
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).length !== 1 ||
        !('input' in body || 'workflow' in body)
      )
        throw new HttpError(400, 'Send either {input} or {workflow}');
      const { input, workflow } = body as Record<string, unknown>;
      if (workflow !== undefined && typeof workflow !== 'string')
        throw new HttpError(400, 'workflow must be YAML or JSON text');
      const written = await writeSpecBundle(
        workspaceDir,
        workflow === undefined ? input : parseInput(workflow),
      );
      json(res, 200, written);
    },
    'POST /api/workspace/index': async (req, res) => {
      if (indexing) throw new HttpError(409, 'Indexing is already running');
      const controller = new AbortController();
      indexing = controller;
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const index = await writeWorkspaceIndex(workspaceDir, {
          signal: controller.signal,
        });
        json(res, 200, {
          workspace: basename(workspaceDir),
          indexed: true,
          fresh: true,
          index,
        });
      } finally {
        indexing = null;
      }
    },
    /** Lists a server's tools or skills; headers are used for this request only. */
    'POST /api/discover': async (req, res) => {
      // A JSON body needs a CORS preflight, which other origins cannot pass.
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      // One discovery at a time; a new one replaces the one still running.
      discovering?.abort();
      const controller = new AbortController();
      discovering = controller;
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const request = parseDiscoveryRequest(await readBody(req));
        json(res, 200, await discover(request, { signal: controller.signal }));
      } catch (e) {
        throw e instanceof DiscoveryError
          ? new HttpError(e.status, e.message)
          : e;
      } finally {
        if (discovering === controller) discovering = null;
      }
    },
    'POST /api/demo': async (req, res) => {
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some((k) => !['designHash', 'pattern'].includes(k))
      )
        throw new HttpError(
          400,
          'Demo accepts only bundled designHash and pattern',
        );
      const { designHash, pattern } = body as Record<string, unknown>;
      const input = flightInput(),
        report = suggestDesign(input),
        candidate = report.connections[0].candidates.find(
          (c) => c.id === pattern,
        );
      if (designHash !== report.designHash || !candidate?.executableHere)
        throw new HttpError(
          409,
          'Stale, tampered or unsupported design. Restore and analyze the bundled fixture.',
        );
      if (session || starting) {
        res.setHeader('Retry-After', '120');
        throw new HttpError(429, 'The local sandbox is already active');
      }
      starting = true;
      let fixture: Awaited<ReturnType<typeof startFixture>>;
      try {
        fixture = await startFixture(options.fixtureLatencyMs);
      } finally {
        starting = false;
      }
      if (res.destroyed) {
        await fixture.close();
        return;
      }
      const id = randomUUID(),
        token = randomBytes(32).toString('hex');
      let bytes = 0,
        closed = false;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
      });
      res.flushHeaders();
      const send = (event: DemoEvent) => {
        if (closed || res.destroyed) return;
        const line = JSON.stringify(event) + '\n';
        bytes += Buffer.byteLength(line);
        if (bytes > 1048576) {
          session?.runner.stop('output-limit');
          return;
        }
        if (!res.write(line)) session?.runner.stop('slow-consumer');
      };
      send({
        formatVersion: '0.2-alpha.1',
        type: 'session',
        atMs: Date.now(),
        sessionId: id,
        actionToken: token,
        message:
          'Local sandbox created; real 15-second HTTP source, 120-second lifetime. Restart begins cold.',
      });
      const finish = () => {
        if (closed) return;
        closed = true;
        session = null;
        void fixture.close();
        if (!res.destroyed) res.end();
      };
      const operation = selectedOperation(input);
      const runner = runDemo(candidate, {
        endpoint: fixture.endpoint,
        outputSchema: operation.outputSchema!,
        inputSchema: operation.inputSchema!,
        onEvent: send,
        lifetimeMs: options.lifetimeMs,
        onTerminal: finish,
      });
      session = { id, token, actions: 0, send, runner, fixture };
      res.on('close', () => {
        runner.stop('disconnected');
        finish();
      });
    },
  };
  const action = async (
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const supplied = String(req.headers['x-plug-action-token'] ?? '');
    const s = session;
    if (
      !s ||
      s.id !== id ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(s.token))
    )
      throw new HttpError(404, 'Unknown session or token');
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).some((k) => !['action', 'key'].includes(k)) ||
      !['request', 'expire', 'fail-next-refresh', 'change-data'].includes(
        body.action as string,
      ) ||
      (body.key !== undefined &&
        !['hot0', 'hot1', 'cold'].includes(body.key as string))
    )
      throw new HttpError(400, 'Use a fixed action and fixture key');
    if (s.actions >= 20) {
      res.setHeader('Retry-After', '120');
      throw new HttpError(429, 'Twenty-action session limit reached');
    }
    s.actions++;
    const actionId = randomUUID();
    json(res, 202, { actionId, acknowledged: true });
    if (body.action === 'request')
      void s.runner.request(
        body.key === 'cold' ? coldKey : keys[body.key === 'hot1' ? 1 : 0],
        actionId,
      );
    else if (body.action === 'expire') s.runner.expire(actionId);
    else if (body.action === 'fail-next-refresh') {
      s.fixture.fail();
      s.send({
        formatVersion: '0.2-alpha.1',
        type: 'fault-armed',
        atMs: Date.now(),
        actionId,
        message:
          'Next refresh call will fail; foreground requests are unaffected.',
      });
    } else {
      const version = s.fixture.change();
      s.send({
        formatVersion: '0.2-alpha.1',
        type: 'data-change',
        atMs: Date.now(),
        actionId,
        message: `Source changed to version ${version}; existing snapshots keep their captured version.`,
      });
    }
  };
  const serveStatic = async (pathname: string, res: ServerResponse) => {
    const target = resolve(uiDir, '.' + decodeURIComponent(pathname));
    if (target !== uiDir && !target.startsWith(uiDir + sep))
      throw new HttpError(404, 'Not found');
    let file = target;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = join(uiDir, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Plug UI assets are not built. Run npm run build.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'max-age=300',
    });
    res.end(body);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const host = req.headers.host ?? '';
      if (!allowedHosts.includes(host))
        throw new HttpError(403, 'Loopback host required');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`)
          throw new HttpError(403, 'Same-origin requests only');
        const route = routes[`${req.method} ${url.pathname}`];
        const match = /^\/api\/demo\/([0-9a-f-]{36})\/actions$/.exec(
          url.pathname,
        );
        if (route) await route(req, res);
        else if (match && req.method === 'POST')
          await action(match[1], req, res);
        else throw new HttpError(404, 'Not found');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new HttpError(405, 'Method not allowed');
      await serveStatic(url.pathname, res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, e instanceof HttpError ? e.status : 400, {
        error: e instanceof Error ? e.message : 'Invalid request',
      });
    }
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 4319, '127.0.0.1', () => done());
  });
  port = (server.address() as AddressInfo).port;
  const close = async () => {
    indexing?.abort();
    discovering?.abort();
    session?.runner.stop('process-shutdown');
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return { server, url: `http://127.0.0.1:${port}`, port, close };
}
