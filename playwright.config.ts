import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:3000', headless: true },
  webServer: {
    command: process.env.PLUG_TEST_PRODUCTION ? 'npm start' : 'npm run dev',
    url: 'http://127.0.0.1:3000/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  workers: 1,
});
