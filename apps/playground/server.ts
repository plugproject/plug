import express from 'express';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { createApp, errorHandler } from './service';
const { app, cleanup } = createApp();
let vite: ViteDevServer | undefined;
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  vite = await createServer({
    configFile: resolve('apps/playground/vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve('apps/playground/dist')));
  app.get('/{*path}', (_req, res) =>
    res.sendFile(resolve('apps/playground/dist/index.html')),
  );
}
app.use(errorHandler);
const server = app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () =>
  console.log(`Plug available on port ${process.env.PORT ?? 3000}`),
);
const stop = async () => {
  cleanup();
  server.close();
  server.closeAllConnections();
  // The Vite dev server's watchers and HMR socket otherwise keep the
  // process alive past tsx watch's 5s grace period, forcing a kill.
  await vite?.close();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
