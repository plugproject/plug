import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DemoEvent } from '../../packages/plug/src/contracts/index';
import {
  parseInput,
  selectedOperation,
} from '../../packages/plug/src/contracts/index';
import {
  flightInput,
  keys,
  coldKey,
} from '../../packages/plug/src/demo/flight';
import { runDemo } from '../../packages/plug/src/demo/runtime';
import { startFixture } from '../../packages/plug/src/demo/fixture';
import {
  explainDesign,
  suggestDesign,
} from '../../packages/plug/src/recommender/index';
export function createApp(
  options: { fixtureLatencyMs?: number; lifetimeMs?: number } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  // Only configure a numeric hop count after verifying the host's proxy topology.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(hops) || hops < 0 || hops > 4)
    throw new Error('Invalid TRUST_PROXY_HOPS');
  app.set('trust proxy', hops || false);
  const sessions = new Map<
    string,
    {
      token: string;
      actions: number;
      send: (event: DemoEvent) => void;
      runner: ReturnType<typeof runDemo>;
      fixture: Awaited<ReturnType<typeof startFixture>>;
    }
  >();
  let starting = 0;
  const limits = new Map<string, { reset: number; count: number }>();
  const metrics = {
    analyses: 0,
    missingInformation: 0,
    demoStarted: 0,
    terminal: 0,
    results: 0,
    targetMisses: 0,
    cacheHits: 0,
  };
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (process.env.NODE_ENV === 'production')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      const expected =
        process.env.APP_ORIGIN ?? `${req.protocol}://${req.get('host')}`;
      if (origin && origin !== expected) {
        res.status(403).json({ error: 'Same-origin requests only' });
        return;
      }
      const now = Date.now();
      for (const [key, v] of limits) if (v.reset <= now) limits.delete(key);
      const ip = req.ip ?? 'unknown';
      let entry = limits.get(ip);
      if (!entry) {
        if (limits.size >= 1000) {
          res.setHeader('Retry-After', '60');
          res.status(429).json({ error: 'Admission map capacity reached' });
          return;
        }
        entry = { reset: now + 60000, count: 0 };
        limits.set(ip, entry);
      }
      if (++entry.count > 60) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((entry.reset - now) / 1000))),
        );
        res.status(429).json({ error: 'Request limit reached' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use(
    express.text({
      limit: '256kb',
      type: ['text/plain', 'application/yaml', 'text/yaml'],
    }),
  );
  app.get('/healthz', (_req, res) =>
    res.json({
      status: 'ok',
      release:
        process.env.RENDER_GIT_COMMIT ??
        process.env.RELEASE_COMMIT ??
        'local-unreleased',
    }),
  );
  app.get('/api/examples', (_req, res) => res.json({ flight: flightInput() }));
  app.post('/api/analyze', (req, res) => {
    const report = suggestDesign(
      typeof req.body === 'string' ? parseInput(req.body) : req.body,
    );
    metrics.analyses++;
    if (report.missingInformation.length) metrics.missingInformation++;
    res.json({ report, markdown: explainDesign(report) });
  });
  app.post('/api/demo', async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).some((k) => !['designHash', 'pattern'].includes(k))
    ) {
      res
        .status(400)
        .json({ error: 'Demo accepts only bundled designHash and pattern' });
      return;
    }
    const input = flightInput(),
      report = suggestDesign(input),
      candidate = report.connections[0].candidates.find(
        (c) => c.id === body.pattern,
      );
    if (body.designHash !== report.designHash || !candidate?.executableHere) {
      res.status(409).json({
        error:
          'Stale, tampered or unsupported design. Restore and analyze the bundled fixture.',
      });
      return;
    }
    if (sessions.size + starting >= 4) {
      res.setHeader('Retry-After', '120');
      res.status(429).json({ error: 'Four sandboxes are already active' });
      return;
    }
    starting++;
    let fixture: Awaited<ReturnType<typeof startFixture>>;
    try {
      fixture = await startFixture(options.fixtureLatencyMs);
    } finally {
      starting--;
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
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: DemoEvent) => {
      if (closed || res.destroyed) return;
      const line = JSON.stringify(event) + '\n';
      bytes += Buffer.byteLength(line);
      if (bytes > 1048576) {
        sessions.get(id)?.runner.stop('output-limit');
        return;
      }
      if (event.type === 'result-delivery') metrics.results++;
      if (event.type === 'target-miss') metrics.targetMisses++;
      if (event.type === 'cache-hit') metrics.cacheHits++;
      if (!res.write(line)) sessions.get(id)?.runner.stop('slow-consumer');
    };
    send({
      formatVersion: '0.2-alpha.1',
      type: 'session',
      atMs: Date.now(),
      sessionId: id,
      actionToken: token,
      message:
        'Isolated sandbox created; real 15-second HTTP source, 120-second lifetime. Restart begins cold.',
    });
    const finish = () => {
      if (closed) return;
      closed = true;
      metrics.terminal++;
      sessions.delete(id);
      void fixture.close();
      if (!res.destroyed) res.end();
      // Aggregate counts only: no IDs, tokens, descriptors or payloads.
      console.info(JSON.stringify({ event: 'demo-terminal', ...metrics }));
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
    sessions.set(id, { token, actions: 0, send, runner, fixture });
    metrics.demoStarted++;
    res.on('close', () => {
      runner.stop('disconnected');
      finish();
    });
  });
  app.post('/api/demo/:id/actions', (req, res) => {
    const session = sessions.get(String(req.params.id));
    const supplied = req.header('X-Plug-Action-Token') ?? '';
    if (
      !session ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.token))
    ) {
      res.status(404).json({ error: 'Unknown session or token' });
      return;
    }
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).some((k) => !['action', 'key'].includes(k)) ||
      !['request', 'expire', 'fail-next-refresh', 'change-data'].includes(
        body.action,
      ) ||
      (body.key !== undefined && !['hot0', 'hot1', 'cold'].includes(body.key))
    ) {
      res.status(400).json({ error: 'Use a fixed action and fixture key' });
      return;
    }
    if (session.actions >= 20) {
      res.setHeader('Retry-After', '120');
      res.status(429).json({ error: 'Twenty-action session limit reached' });
      return;
    }
    session.actions++;
    const actionId = randomUUID();
    res.status(202).json({ actionId, acknowledged: true });
    if (body.action === 'request')
      void session.runner.request(
        body.key === 'cold' ? coldKey : keys[body.key === 'hot1' ? 1 : 0],
        actionId,
      );
    else if (body.action === 'expire') session.runner.expire(actionId);
    else if (body.action === 'fail-next-refresh') {
      session.fixture.fail();
      session.send({
        formatVersion: '0.2-alpha.1',
        type: 'fault-armed',
        atMs: Date.now(),
        actionId,
        message:
          'Next refresh call will fail; foreground requests are unaffected.',
      });
    } else {
      const version = session.fixture.change();
      session.send({
        formatVersion: '0.2-alpha.1',
        type: 'data-change',
        atMs: Date.now(),
        actionId,
        message: `Source changed to version ${version}; existing snapshots keep their captured version.`,
      });
    }
  });
  const cleanup = () => {
    for (const s of sessions.values()) s.runner.stop('process-shutdown');
    limits.clear();
  };
  return { app, cleanup, metrics, sessions };
}
export const errorHandler: express.ErrorRequestHandler = (
  error,
  _req,
  res,
  _next,
) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(error.type === 'entity.too.large' ? 413 : 400).json({
    error:
      error.type === 'entity.too.large'
        ? 'Description exceeds 256 KB'
        : error instanceof Error
          ? error.message
          : 'Invalid request',
  });
};
