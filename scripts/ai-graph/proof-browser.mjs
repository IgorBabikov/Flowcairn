import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startViewer } from '../../tools/ai-graph-viewer/server.mjs';
import { fixture } from './test-support/provable-work.mjs';

// Manual integration smoke: real WorkflowService, HTTP, browser and node:test checks.
// Only AI decisions and workspace allocation use deterministic test adapters. No paid provider call.
const cleanup = [];
const context = { after: (callback) => cleanup.push(callback) };
const secrets = [];
let browser;
const runningServers = [];
async function openFixture(options) {
  const sample = await fixture(context, options);
  const snapshot = await sample.run();
  const token = randomBytes(32).toString('hex'); secrets.push(token);
  const server = startViewer({ service: sample.service, token, port: 0 }); runningServers.push(server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`http://127.0.0.1:${address.port}/#session=${token}`);
  await expect(page.getByRole('region', { name: 'Задача и доказательства', exact: true })).toBeVisible();
  return { sample, snapshot, page };
}

try {
  await import('../../tools/ai-graph-viewer/build.mjs');
  browser = await chromium.launch({ headless: true });
  const success = await openFixture({});
  const { sample, snapshot, page } = success;
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
  await expect(page.getByTestId('requirement-coverage')).toContainText('1 из 1');
  assert.deepEqual(sample.checkExitCodes(), [0]);
  const evidence = snapshot.proof.evidence.find((item) => item.method === 'check' && item.status === 'passed');
  assert.ok(evidence);
  const receiptResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/receipts/${evidence.receiptId}`));
  await page.getByRole('region', { name: 'Доказательство требования', exact: true }).getByRole('button', { name: 'Открыть отчет проверки', exact: true }).first().click();
  const receipt = await (await receiptResponse).json();
  assert.equal(receipt.verdict, 'pass'); assert.equal(receipt.checks[0].exitCode, 0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.screenshot({ path: '/tmp/flowcairn-actual-cockpit.png', fullPage: true });

  const beforeRevision = sample.service.revision(snapshot.runId);
  writeFileSync(path.join(sample.worktree, 'src/answer.mjs'), 'export const answer = () => 13;\n');
  assert.equal(sample.service.revision(snapshot.runId), beforeRevision);
  // The live UI polls even without an SSE revision: external file changes never update persisted revision.
  await expect(page.getByTestId('task-proof-status')).toHaveText('Нужна повторная проверка', { timeout: 45000 });
  await expect(page.getByTestId('requirement-coverage')).toContainText('0 из 1');
  await expect(page.locator('.completion-certificate')).toHaveCount(0);
  assert.equal(sample.service.revision(snapshot.runId), beforeRevision);
  assert.equal(sample.service.snapshot(snapshot.runId).proof.status, 'STALE');
  await page.screenshot({ path: '/tmp/flowcairn-actual-cockpit-stale.png', fullPage: true });
  await page.close();

  const human = await openFixture({ method: 'human' });
  await expect(human.page.getByTestId('task-proof-status')).toHaveText('Результат пока не подтвержден');
  const accept = human.page.getByRole('button', { name: 'Подтверждаю выполнение требования', exact: true });
  await expect(accept).toBeDisabled();
  await human.page.getByLabel('Что вы проверили и чем подтверждается результат?').fill('Проверил тестовый результат: функция answer возвращает 42.');
  const acceptedResponse = human.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/control/verify-requirement'));
  await accept.click();
  assert.equal((await acceptedResponse).status(), 200);
  await expect(human.page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
  const accepted = human.sample.service.snapshot(human.snapshot.runId);
  assert.equal(accepted.proof.status, 'PROVEN');
  assert.equal(human.sample.service.store.readRun(accepted.runId).requirementReceipts.length, 1);
  assert.equal(accepted.proof.evidence.some((item) => item.method === 'human' && item.status === 'passed'), true);
  await human.page.screenshot({ path: '/tmp/flowcairn-actual-cockpit-human.png', fullPage: true });
  await human.page.close();
  console.log(JSON.stringify({ passed: true, service: 'WorkflowService', transport: 'actual HTTP', browser: 'Chromium',
    ai: 'deterministic injected outputs; no provider calls', checks: 'real node --test', scenarios: ['PROVEN', 'receipt drill-down', 'live source drift without revision', 'human acceptance through UI'],
    screenshot: '/tmp/flowcairn-actual-cockpit.png' }));
} catch (error) {
  let message = error?.stack ?? String(error);
  for (const secret of secrets) message = message.replaceAll(secret, '[session redacted]');
  console.error(message); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of runningServers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const callback of cleanup.reverse()) await callback();
}
