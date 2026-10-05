import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = Number(process.env.PLUG_TEST_PORT ?? 3000);
const workbenchPort = port + 1;
// Workers re-evaluate this file, so tests read the same values from the environment.
process.env.PLUG_WORKBENCH_URL = `http://127.0.0.1:${workbenchPort}`;
process.env.PLUG_WORKBENCH_DIR = join(tmpdir(), 'plug-workbench-e2e');
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: [
    {
      command: process.env.PLUG_TEST_PRODUCTION ? 'npm start' : 'npm run dev',
      url: `http://127.0.0.1:${port}/healthz`,
      env: { PORT: String(port) },
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      // The packaged workbench; run npm run build first.
      command: `rm -rf "${process.env.PLUG_WORKBENCH_DIR}" && mkdir -p "${process.env.PLUG_WORKBENCH_DIR}" && node packages/plug/dist/cli.js ui --port ${workbenchPort} --workspace "${process.env.PLUG_WORKBENCH_DIR}"`,
      url: `${process.env.PLUG_WORKBENCH_URL}/api/examples`,
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
  workers: 1,
});
