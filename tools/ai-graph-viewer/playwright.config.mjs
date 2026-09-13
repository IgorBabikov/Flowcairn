import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const viewerDirectory = fileURLToPath(new URL('.', import.meta.url));

const fixtureUrl = 'http://127.0.0.1:4329';
const configuredUrl = process.env.FLOWCAIRN_TEST_URL;
const baseURL = configuredUrl ? new URL(configuredUrl).origin : fixtureUrl;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: configuredUrl
    ? undefined
    : {
        command: `"${process.execPath}" tests/fixture-server.mjs`,
        cwd: viewerDirectory,
        url: fixtureUrl,
        reuseExistingServer: false,
        timeout: 15_000,
      },
});
