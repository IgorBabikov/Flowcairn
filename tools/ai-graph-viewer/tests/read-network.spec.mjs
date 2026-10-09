import { expect, test } from '@playwright/test';
import { book, openDiagnostics, selectRun, stepDetails, visitResult } from './ui-paths.mjs';
import { allDenied, allowed, graphNode, implementationNode, mockApi, runSummary, snapshot } from './fixtures.mjs';

const readBanner = page => page.locator('.error-banner').filter({ hasText: 'Не удалось обновить данные' });
const running = () => ({ ...snapshot(), status: 'running', execution: { state: 'running', stopRequested: false },
  capabilities: { ...allDenied, stop: allowed } });

test('a delayed initial read failure cannot replace a newer snapshot of the same run', async ({ page }) => {
  const fixture = await mockApi(page);
  let snapshotRequests = 0, heldPlan;
  await page.route('**/snapshot', route => {
    snapshotRequests++;
    if (snapshotRequests === 1) return route.abort('connectionreset');
    if (snapshotRequests === 2) return route.fallback();
    // Hold later polls so they cannot hide the stale initial error by recovering again.
  });
  await page.route('**/plan', route => { heldPlan = route; });
  await visitResult(page);
  await expect.poll(() => Boolean(heldPlan)).toBe(true);
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(0);
  await expect(page.getByTestId('rpg-runtime-status')).not.toHaveText(/Результат неизвестен|Состояние недоступно/);
  const planResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/plan'));
  await heldPlan.fallback();
  await planResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(readBanner(page)).toHaveCount(0);
  await expect(page.getByTestId('rpg-runtime-status')).not.toHaveText(/Результат неизвестен|Состояние недоступно/);
});

test('an old initial success cannot hide a newer failed snapshot while plan is loading', async ({ page }) => {
  await mockApi(page);
  let snapshotRequests = 0, heldPlan;
  await page.route('**/snapshot', route => {
    snapshotRequests++;
    if (snapshotRequests === 1) return route.fallback();
    if (snapshotRequests === 2) return route.abort('connectionreset');
  });
  await page.route('**/plan', route => { heldPlan = route; });
  await visitResult(page);
  await expect(readBanner(page)).toBeVisible();
  const planResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/plan'));
  await heldPlan.fallback();
  await planResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(readBanner(page)).toBeVisible();
  await expect(book(page).locator('.task-overview')).toHaveCount(0);
  await expect(book(page).getByRole('heading', { name: 'Готово к вашему ревью', exact: true })).toHaveCount(0);
  await openDiagnostics(page, 'nodes');
  await expect(stepDetails(page)).toHaveCount(0);
  await expect(book(page).getByRole('button', { name: 'Запустить', exact: true })).toHaveCount(0);
});

test('failed snapshot GET has read-only copy and clears after the same resource recovers', async ({ page }) => {
  const fixture = await mockApi(page);
  let recover = false, reads = 0;
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.route('**/snapshot', route => {
    reads++;
    return recover ? route.fallback() : route.abort('connectionreset');
  });
  await visitResult(page);
  await expect(readBanner(page)).toBeVisible();
  await expect(page.getByText('Результат операции неизвестен', { exact: false })).toHaveCount(0);
  recover = true;
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(0);
  await expect(readBanner(page)).toHaveCount(0);
  expect(reads).toBeGreaterThan(1);
  expect(posts).toEqual([]);
});

test('snapshot recovery cannot clear a failed project GET', async ({ page }) => {
  const fixture = await mockApi(page);
  let recoverProject = false;
  await page.route('**/api/project', route => recoverProject ? route.fallback() : route.abort('connectionreset'));
  await visitResult(page);
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(0);
  await expect(readBanner(page)).toBeVisible();
  const previous = fixture.snapshotReads();
  await expect.poll(() => fixture.snapshotReads(), { timeout: 10_000 }).toBeGreaterThan(previous);
  await expect(readBanner(page)).toBeVisible();
  recoverProject = true;
  await readBanner(page).getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(readBanner(page)).toHaveCount(0);
});

test('successful GET does not dismiss an unknown POST outcome or allocate a new operation ID', async ({ page }) => {
  const current = { ...snapshot(), status: 'ready', gates: [],
    nodes: [graphNode({ status: 'passed', capabilities: allDenied }), { ...implementationNode, capabilities: { ...allDenied, run: allowed } }],
    capabilities: { ...allDenied, run: allowed } };
  const fixture = await mockApi(page, current, { loseFirstRunResponse: true });
  await visitResult(page);
  await book(page).locator('.diagnostic-tools').getByRole('button', { name: 'Запустить', exact: true }).click();
  const unknown = page.locator('.error-banner').filter({ hasText: 'Результат операции неизвестен' });
  await expect(unknown).toBeVisible();
  const previous = fixture.snapshotReads();
  await expect.poll(() => fixture.snapshotReads(), { timeout: 10_000 }).toBeGreaterThan(previous);
  await expect(unknown).toBeVisible();
  await unknown.getByRole('button', { name: 'Повторить тот же запрос' }).click();
  await expect.poll(() => fixture.calls.filter(call => call.action === 'run').length).toBe(2);
  const requests = fixture.calls.filter(call => call.action === 'run');
  expect(requests[0].body.operationId).toBe(requests[1].body.operationId);
});

test('a failed list GET after a confirmed POST recovers without replaying the command', async ({ page }) => {
  const current = { ...snapshot(), status: 'ready', gates: [],
    nodes: [graphNode({ status: 'passed', capabilities: allDenied }), { ...implementationNode, capabilities: { ...allDenied, run: allowed } }],
    capabilities: { ...allDenied, run: allowed } };
  const fixture = await mockApi(page, current, { loseFirstRunResponse: false });
  let failList = false;
  page.on('request', request => { if (request.url().endsWith('/control/run')) failList = true; });
  await page.route('**/api/runs', route => failList ? route.abort('connectionreset') : route.fallback());
  await visitResult(page);
  await book(page).locator('.diagnostic-tools').getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(readBanner(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить тот же запрос' })).toHaveCount(0);
  failList = false;
  await readBanner(page).getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(readBanner(page)).toHaveCount(0);
  expect(fixture.calls.filter(call => call.action === 'run')).toHaveLength(1);
});

for (const [kind, status, code, message] of [
  ['permission', 403, 'PERMISSION_DENIED', 'Нет доступа к просмотру задачи'],
  ['validation', 400, 'VALIDATION_FAILED', 'Данные ответа не прошли проверку'],
]) test(`successful snapshot GET does not erase a ${kind} failure`, async ({ page }) => {
  const fixture = await mockApi(page);
  let reject = true;
  await page.route('**/snapshot', route => reject
    ? route.fulfill({ status, json: { error: { code, message } } })
    : route.fallback());
  await visitResult(page);
  await expect(page.locator('.error-banner')).toContainText(message);
  reject = false;
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(0);
  await expect(page.locator('.error-banner')).toContainText(message);
});

test('a late failed read of the old run cannot show a banner on the new run', async ({ page }) => {
  const current = running();
  const other = { ...snapshot(), runId: 'run-other', updatedAt: '2020-01-01T00:00:00Z',
    task: { ...snapshot().task, id: 'TASK-202', taskNumber: 'FORM-202', goal: 'Другая задача' } };
  await mockApi(page, current, { loseStopResponse: true, extraRuns: [runSummary(other)] });
  let mode = 'pass', held;
  await page.route('**/run-other/snapshot', route => route.fulfill({ json: other }));
  await page.route('**/run-demo/snapshot', route => {
    if (mode === 'fail') return route.abort('connectionreset');
    if (mode === 'hold') { mode = 'pass'; held = route; return; }
    return route.fallback();
  });
  await visitResult(page);
  await expect(page.getByRole('button', { name: 'Остановить', exact: true })).toBeVisible();
  mode = 'fail';
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  const stopError = page.locator('.error-banner').filter({ hasText: 'Не удалось подтвердить остановку' });
  await expect(stopError).toBeVisible();
  mode = 'hold';
  await stopError.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await selectRun(page, 'FORM-202');
  await expect(book(page).locator('.diagnostic-heading p')).toHaveText('Другая задача');
  const failed = page.waitForEvent('requestfailed', request => request.url().endsWith('/run-demo/snapshot'));
  await held.abort('connectionreset');
  await failed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.error-banner').filter({ hasText: /Результат операции неизвестен|Не удалось обновить данные/ })).toHaveCount(0);
});
