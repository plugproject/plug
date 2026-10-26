import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProbeFixture {
  base: string;
  calls: { method: string; url: string; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

export async function startProbeServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    call: number,
  ) => void | Promise<void>,
): Promise<ProbeFixture> {
  const calls: ProbeFixture['calls'] = [];
  const server = createServer(async (request, response) => {
    calls.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    try {
      await handler(request, response, calls.length);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'fixture error');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
