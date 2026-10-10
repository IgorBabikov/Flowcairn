import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: 'guild-*.spec.mjs', workers: 1, fullyParallel: false,
  timeout: 120000, expect: { timeout: 15000 }, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../output/product-completion/rpg/qa/playwright', import.meta.url)),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
