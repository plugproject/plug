import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { outputSchema } from './flight';
export { outputSchema };
/** A separate real HTTP source. Snapshot time and version are captured at request start. */
export async function startFixture(latencyMs = 15000) {
  let version = 1,
    failNext = false,
    active = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/search') {
      res.writeHead(404).end();
      return;
    }
    if (active >= 2) {
      res.writeHead(429, { 'Retry-After': '1' }).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16384) req.destroy();
    });
    req.on('end', () => {
      let key: Record<string, unknown>;
      try {
        key = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const snapshotAt = Date.now(),
        capturedVersion = version,
        fail = failNext && req.headers['x-plug-refresh'] === 'true';
      if (fail) failNext = false;
      active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          active--;
          clearTimeout(timer);
          timers.delete(timer);
        }
      };
      const timer = setTimeout(() => {
        release();
        if (fail) {
          res.writeHead(503).end('Synthetic source failure');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            snapshotAt,
            version: capturedVersion,
            data: {
              offers: [
                {
                  id: `${key.origin ?? 'FROM'}-${key.destination ?? 'TO'}-v${capturedVersion}`,
                  price: 42000 + capturedVersion * 100,
                  currency: key.currency ?? 'INR',
                },
              ],
            },
          }),
        );
      }, latencyMs);
      timers.add(timer);
      res.on('close', release);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`,
    fail: () => {
      failNext = true;
    },
    change: () => ++version,
    close: async () => {
      timers.forEach(clearTimeout);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
