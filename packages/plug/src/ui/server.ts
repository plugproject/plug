import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { adoptDesign, clearAdoptedDesign } from '../adoption/index';
import {
  assertContract,
  localDocumentLimit,
  parseInput,
  selectedOperation,
  validateInput,
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
import {
  crossCheckerFromEnv,
  DraftError,
  draftFacts,
  drafterFromEnv,
  parseDraftRequest,
} from '../judgment/draft';
import { JudgmentError, judge, providerFromEnv } from '../judgment/index';
import { readSpecBundle, writeSpecBundle } from '../openspec/bundle';
import { listSpecRevisions, readSpecRevision } from '../openspec/revisions';
import {
  addAuthorizedHost,
  executeProbe,
  readAuthorizedHosts,
  readOperationManifests,
} from '../probe/index';
import { explainDesign, suggestDesign } from '../recommender/index';
import {
  readRecentReviews,
  reviewerFromEnv,
  reviewCheckerFromEnv,
  reviewDesign,
  ReviewError,
} from '../review/index';
import {
  readVerificationRecords,
  verifyEdge,
  VerificationError,
} from '../verify/index';
import {
  readGitWorkflowHistory,
  readGitWorkflowRevision,
} from '../workspace/git';
export interface UiServerOptions {
  port?: number;
  workspaceDir?: string;
  uiDir?: string;
  fixtureLatencyMs?: number;
  lifetimeMs?: number;
  /** Optional stricter request bound; the supported local ceiling remains 64 MB. */
  bodyLimitBytes?: number;
}
const revisionPattern = /^[a-f0-9]{64}$/;
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
async function readBody(
  req: IncomingMessage,
  bodyLimit = localDocumentLimit,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > bodyLimit)
      throw new HttpError(
        413,
        `Description exceeds ${
          bodyLimit === localDocumentLimit
            ? '64 MB'
            : `${Math.ceil(bodyLimit / 1024)} KB`
        }`,
      );
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
  const requestBodyLimit = Math.min(
    localDocumentLimit,
    Math.max(1, options.bodyLimitBytes ?? localDocumentLimit),
  );
  const readRequestBody = (req: IncomingMessage) =>
    readBody(req, requestBodyLimit);
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
      const report = suggestDesign(await readRequestBody(req), {
        authorizedHosts: await readAuthorizedHosts(workspaceDir),
      });
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
      const git = await readGitWorkflowHistory(workspaceDir);
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
          git,
        },
      });
    },
    'GET /api/workspace/spec': async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const revision = url.searchParams.get('revision');
      const commit = url.searchParams.get('commit');
      if (revision && commit)
        throw new HttpError(400, 'Choose either revision or commit');
      if (revision) {
        if (!revisionPattern.test(revision))
          throw new HttpError(400, 'Invalid revision ID');
        const workflow = await readSpecRevision(workspaceDir, revision);
        if (workflow === null) throw new HttpError(404, 'Revision not found');
        json(res, 200, {
          present: true,
          workflow,
          revisionId: revision,
          source: 'revision',
        });
        return;
      }
      if (commit) {
        const workflow = await readGitWorkflowRevision(workspaceDir, commit);
        if (workflow === null)
          throw new HttpError(404, 'Git revision not found');
        json(res, 200, {
          present: true,
          workflow,
          commit,
          source: 'git',
        });
        return;
      }
      const spec = await readSpecBundle(workspaceDir);
      json(res, 200, {
        present: spec.present,
        consistent: spec.consistent,
        workflowEdited: spec.workflowEdited,
        problems: spec.problems,
        workflow: spec.workflow,
        revisionId: spec.currentRevisionId,
      });
    },
    'GET /api/workspace/spec/revisions': async (_req, res) => {
      const [revisions, git] = await Promise.all([
        listSpecRevisions(workspaceDir),
        readGitWorkflowHistory(workspaceDir),
      ]);
      json(res, 200, { revisions, git });
    },
    'POST /api/workspace/spec': async (req, res) => {
      const body = await readRequestBody(req);
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
        'ui',
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
    /** Lists a server's tools, skills or OpenAPI operations; headers are used for this request only. */
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
        const request = parseDiscoveryRequest(await readRequestBody(req));
        json(res, 200, await discover(request, { signal: controller.signal }));
      } catch (e) {
        throw e instanceof DiscoveryError
          ? new HttpError(e.status, e.message)
          : e;
      } finally {
        if (discovering === controller) discovering = null;
      }
    },
    'GET /api/probe': async (_req, res) => {
      json(res, 200, {
        operations: await readOperationManifests(workspaceDir),
        authorizedOrigins: (await readAuthorizedHosts(workspaceDir)).map(
          (host) => host.host,
        ),
      });
    },
    /** Author-authorized local inspection. Events are streamed as NDJSON. */
    'POST /api/probe': async (req, res) => {
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const body = (await readRequestBody(req)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) =>
            ![
              'input',
              'systemId',
              'operationId',
              'authorize',
              'inspect',
            ].includes(key),
        ) ||
        (body.systemId !== undefined && typeof body.systemId !== 'string') ||
        (body.operationId !== undefined &&
          typeof body.operationId !== 'string') ||
        (body.authorize !== undefined && typeof body.authorize !== 'boolean') ||
        (body.inspect !== undefined && typeof body.inspect !== 'boolean')
      )
        throw new HttpError(
          400,
          'Send optional input, systemId, operationId, authorize and inspect',
        );
      const stored = await readSpecBundle(workspaceDir);
      const input = validateInput(body.input ?? stored.input);
      if (body.authorize === true) {
        const selected = input.systems.filter(
          (system) =>
            body.systemId === undefined || system.id === body.systemId,
        );
        if (!selected.length) throw new HttpError(404, 'System not found');
        for (const iface of selected.flatMap((system) => system.interfaces))
          if (iface.endpoint)
            await addAuthorizedHost(workspaceDir, iface.endpoint, 'ui');
      }
      if (body.inspect === false) {
        json(res, 200, {
          authorized: body.authorize === true,
          inspected: false,
        });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      try {
        const result = await executeProbe(input, {
          workspace: workspaceDir,
          systemId: body.systemId as string | undefined,
          operationId: body.operationId as string | undefined,
          signal: controller.signal,
          onEvent: (event) => res.write(`${JSON.stringify(event)}\n`),
        });
        res.end(
          `${JSON.stringify({
            type: 'probe-summary',
            manifests: result.manifests,
            updatedConnectionIds: result.updatedConnectionIds,
            revisionId: result.revisionId,
            input: result.input,
          })}\n`,
        );
      } catch (error) {
        res.end(
          `${JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : 'Probe failed',
          })}\n`,
        );
      }
    },
    /** Bounded local edge demonstration. Events are streamed as NDJSON. */
    'POST /api/verify': async (req, res) => {
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const body = (await readRequestBody(req)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) =>
            !['input', 'connectionId', 'mode', 'revisionId'].includes(key),
        ) ||
        typeof body.connectionId !== 'string' ||
        !['as-is', 'design'].includes(String(body.mode)) ||
        (body.revisionId !== undefined &&
          (typeof body.revisionId !== 'string' ||
            !revisionPattern.test(body.revisionId)))
      )
        throw new HttpError(
          400,
          'Send {connectionId, mode} and optional input and revisionId',
        );
      const stored = await readSpecBundle(workspaceDir);
      const input = validateInput(body.input ?? stored.input);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      try {
        const record = await verifyEdge(
          input,
          body.connectionId,
          body.mode as 'as-is' | 'design',
          {
            workspace: workspaceDir,
            revisionId:
              (body.revisionId as string | undefined) ??
              stored.currentRevisionId,
            signal: controller.signal,
            onEvent: (event) => res.write(`${JSON.stringify(event)}\n`),
          },
        );
        res.end(`${JSON.stringify({ type: 'verification', record })}\n`);
      } catch (error) {
        res.end(
          `${JSON.stringify({
            type: 'error',
            error:
              error instanceof VerificationError ||
              error instanceof JudgmentError
                ? error.message
                : 'Verification failed',
          })}\n`,
        );
      }
    },
    /** One typed judgment per call; the verdict is logged locally and returned for explicit adoption. */
    'POST /api/judge': async (req, res) => {
      // A JSON body needs a CORS preflight, which other origins cannot pass.
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const body = (await readRequestBody(req)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (k) =>
            ![
              'outputMeaning',
              'usefulOutput',
              'context',
              'specRevision',
            ].includes(k),
        )
      )
        throw new HttpError(
          400,
          'Send {outputMeaning, usefulOutput} and optional context and specRevision',
        );
      if (
        body.specRevision !== undefined &&
        (typeof body.specRevision !== 'string' ||
          !revisionPattern.test(body.specRevision))
      )
        throw new HttpError(400, 'specRevision must be a SHA-256 hex digest');
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 30000);
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const result = await judge(
          {
            question: 'output-equivalence',
            outputMeaning: body.outputMeaning as string,
            usefulOutput: body.usefulOutput as string,
            ...(body.context !== undefined
              ? { context: body.context as string }
              : {}),
          },
          providerFromEnv(process.env),
          controller.signal,
        );
        const dir = join(workspaceDir, '.plug');
        await mkdir(dir, { recursive: true });
        await appendFile(
          join(dir, 'judgments.jsonl'),
          JSON.stringify({
            at: result.at,
            question: result.question,
            questionVersion: result.questionVersion,
            model: result.model,
            outputMeaning: body.outputMeaning,
            usefulOutput: body.usefulOutput,
            ...(body.specRevision === undefined
              ? {}
              : { specRevision: body.specRevision }),
            equivalent: result.equivalent,
            confidence: result.confidence,
            rationale: result.rationale,
          }) + '\n',
        );
        json(res, 200, {
          ...result,
          ...(body.specRevision === undefined
            ? {}
            : { specRevision: body.specRevision }),
        });
      } catch (e) {
        throw e instanceof JudgmentError
          ? new HttpError(e.status, e.message)
          : e;
      } finally {
        clearTimeout(deadline);
      }
    },
    /** Drafts supported facts from supplied metadata; proposals require explicit author adoption. */
    'POST /api/draft': async (req, res) => {
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 30000);
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const request = parseDraftRequest(await readRequestBody(req));
        const result = await draftFacts(
          request,
          drafterFromEnv(process.env),
          crossCheckerFromEnv(process.env),
          controller.signal,
        );
        const dir = join(workspaceDir, '.plug');
        await mkdir(dir, { recursive: true });
        await appendFile(
          join(dir, 'drafts.jsonl'),
          JSON.stringify({
            at: result.createdAt,
            version: result.version,
            model: result.model,
            basisHash: result.basisHash,
            ...(result.specRevision
              ? { specRevision: result.specRevision }
              : {}),
            target: result.target,
            requested: request.requested,
            proposals: result.proposals,
          }) + '\n',
        );
        json(res, 200, result);
      } catch (e) {
        throw e instanceof DraftError ? new HttpError(e.status, e.message) : e;
      } finally {
        clearTimeout(deadline);
      }
    },
    /** Critiques an engine-computed shortlist; citations and Jev judgments are code-gated. */
    'POST /api/review': async (req, res) => {
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const body = (await readRequestBody(req)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) =>
            ![
              'input',
              'connectionId',
              'operationalContext',
              'specRevision',
            ].includes(key),
        ) ||
        typeof body.connectionId !== 'string' ||
        (body.operationalContext !== undefined &&
          typeof body.operationalContext !== 'string') ||
        (body.specRevision !== undefined &&
          (typeof body.specRevision !== 'string' ||
            !revisionPattern.test(body.specRevision)))
      )
        throw new HttpError(
          400,
          'Send {input, connectionId} and optional operationalContext and specRevision',
        );
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 60000);
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const input = validateInput(body.input);
        const design = suggestDesign(input);
        const spec = await readSpecBundle(workspaceDir);
        const connection = input.connections.find(
          (candidate) => candidate.id === body.connectionId,
        );
        if (!connection) throw new HttpError(404, 'Connection not found');
        const manifest =
          (await readOperationManifests(workspaceDir))
            .reverse()
            .find(
              (candidate) =>
                candidate.systemId === connection.downstreamSystemId &&
                candidate.operationId === connection.downstreamOperationId,
            ) ?? null;
        const verification =
          (await readVerificationRecords(workspaceDir))
            .reverse()
            .find(
              (candidate) =>
                candidate.connectionId === body.connectionId &&
                candidate.designHash === design.designHash &&
                candidate.revisionId === spec.currentRevisionId,
            ) ?? null;
        const result = await reviewDesign(
          input,
          design,
          body.connectionId,
          reviewerFromEnv(process.env),
          reviewCheckerFromEnv(process.env),
          {
            operationalContext: body.operationalContext,
            manifest,
            verification,
            signal: controller.signal,
          },
        );
        const currentRevisionId = spec.currentRevisionId;
        const pinnedToRevision =
          typeof body.specRevision === 'string' &&
          body.specRevision === currentRevisionId &&
          design.inputHash === spec.summary?.inputHash;
        const dir = join(workspaceDir, '.plug');
        await mkdir(dir, { recursive: true });
        await appendFile(
          join(dir, 'reviews.jsonl'),
          JSON.stringify({
            at: result.createdAt,
            specRevision: body.specRevision ?? null,
            pinnedToRevision,
            ...result,
          }) + '\n',
        );
        json(res, 200, {
          ...result,
          specRevision: body.specRevision ?? null,
          pinnedToRevision,
        });
      } catch (error) {
        throw error instanceof ReviewError
          ? new HttpError(error.status, error.message)
          : error;
      } finally {
        clearTimeout(deadline);
      }
    },
    /** Records or clears the author's design pin after deterministic re-checking. */
    'POST /api/adopt': async (req, res) => {
      if (
        !String(req.headers['content-type'] ?? '').startsWith(
          'application/json',
        )
      )
        throw new HttpError(415, 'Use application/json');
      const body = (await readRequestBody(req)) as
        Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) =>
            ![
              'input',
              'connectionId',
              'architectureId',
              'patterns',
              'reviewHash',
              'clear',
            ].includes(key),
        ) ||
        typeof body.connectionId !== 'string' ||
        (body.architectureId !== undefined &&
          typeof body.architectureId !== 'string') ||
        (body.patterns !== undefined &&
          (!Array.isArray(body.patterns) ||
            !body.patterns.every((value) => typeof value === 'string'))) ||
        (body.reviewHash !== undefined &&
          (typeof body.reviewHash !== 'string' ||
            !revisionPattern.test(body.reviewHash))) ||
        (body.clear !== undefined && typeof body.clear !== 'boolean')
      )
        throw new HttpError(
          400,
          'Send input, connectionId and architectureId, or clear=true',
        );
      const input = validateInput(body.input);
      if (body.clear === true) {
        const cleared = clearAdoptedDesign(input, body.connectionId);
        const written = await writeSpecBundle(
          workspaceDir,
          cleared.input,
          'adopt',
        );
        json(res, 200, {
          input: cleared.input,
          design: cleared.design,
          markdown: explainDesign(cleared.design),
          written,
        });
        return;
      }
      if (typeof body.architectureId !== 'string')
        throw new HttpError(400, 'architectureId is required');
      let review: Record<string, unknown> | null = null;
      if (typeof body.reviewHash === 'string') {
        review =
          (
            await readRecentReviews(
              join(workspaceDir, '.plug', 'reviews.jsonl'),
            )
          )
            .reverse()
            .find(
              (candidate) =>
                candidate.reviewHash === body.reviewHash &&
                candidate.connectionId === body.connectionId,
            ) ?? null;
        const adoptable = (
          review?.decision as { adoptable?: unknown } | undefined
        )?.adoptable;
        if (
          !review ||
          !Array.isArray(adoptable) ||
          !adoptable.includes(body.architectureId)
        )
          throw new HttpError(
            409,
            'The pinned review does not mark this architecture adoptable',
          );
      }
      const critic =
        typeof review?.criticModel === 'string'
          ? review.criticModel
          : 'no critic';
      const jev =
        typeof review?.jevModel === 'string' ? review.jevModel : 'unverified';
      const adopted = adoptDesign(input, body.connectionId, {
        architectureId: body.architectureId,
        patterns: body.patterns as string[] | undefined,
        evidence: {
          kind: 'declared',
          note:
            `Adopted by the author after design review by ${critic}; ` +
            `Jev ${jev}.`,
          source: {
            type: 'design-review',
            location: `${critic}@${body.reviewHash ?? 'author-choice'}`,
          },
        },
      });
      const written = await writeSpecBundle(
        workspaceDir,
        adopted.input,
        'adopt',
      );
      json(res, 200, {
        input: adopted.input,
        design: adopted.design,
        markdown: explainDesign(adopted.design),
        written,
      });
    },
    'POST /api/demo': async (req, res) => {
      const body = await readRequestBody(req);
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
    const body = (await readRequestBody(req)) as
      Record<string, unknown> | undefined;
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
