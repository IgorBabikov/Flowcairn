import { expect, test } from '@playwright/test';
import {
  allDenied,
  allowed,
  graphNode,
  implementationNode,
  mockApi,
  plan,
  projectContext,
  runSummary,
  snapshot,
  token,
} from './fixtures.mjs';
import { book, stepPicker, stepDetails, openDiagnostics, openJournal, newQuest, selectRun, selectStep, showVersion } from './ui-paths.mjs';

function runnableSnapshot() {
  const current = snapshot();
  current.status = 'ready';
  current.gates = [];
  current.nodes = [
    graphNode({ status: 'passed', capabilities: allDenied }),
    {
      ...implementationNode,
      capabilities: { ...allDenied, run: allowed },
    },
  ];
  current.capabilities = { ...allDenied, run: allowed };
  return current;
}

function chainSnapshot(overrides = {}) {
  const current = runnableSnapshot();
  current.nodes = Array.from({ length: 11 }, (_, index) =>
    graphNode({
      id: `node-${index}`,
      title: `Этап ${index + 1}`,
      needs: index === 0 ? [] : [`node-${index - 1}`],
      status: index === 0 ? 'passed' : 'ready',
      capabilities: allDenied,
      receiptIds: [],
    }),
  );
  current.edges = current.nodes.slice(1).map((node, index) => ({
    id: `${current.nodes[index].id}--${node.id}`,
    source: current.nodes[index].id,
    target: node.id,
  }));
  return Object.assign(current, overrides);
}

async function readableStep(page, title) {
  await expect(stepPicker(page).locator('option:checked')).toContainText(title);
  const heading = stepDetails(page).getByRole('heading', { name: title, exact: true });
  await expect(heading).toBeVisible();
  await heading.scrollIntoViewIfNeeded();
  const geometry = await heading.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      clipped: element.scrollWidth > element.clientWidth };
  });
  expect(geometry.width).toBeGreaterThan(150);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.clipped).toBe(false);
}

async function version(page) {
  return showVersion(page);
}

test('renders backend state, confirms a gate, and retries one operation id', async ({ page }) => {
  const fixture = await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');

  await expect(page.locator('.game-brand h1')).toHaveText('Flowcairn');
  await selectStep(page, 'approve-plan');
  await expect(stepDetails(page).locator('.fact-list')).toContainText('Чтение');
  await expect(stepDetails(page)).toContainText('project-context · 11111111');
  await selectStep(page, 'implement');
  await expect(stepDetails(page).locator('.fact-list')).toContainText('Запись');
  expect(page.url()).not.toContain('session=');
  expect(await page.evaluate(() => sessionStorage.getItem('flowcairn.graph.session'))).toBe(token);

  await openDiagnostics(page, 'evidence');
  await page.getByRole('button', { name: /Plan evidence/ }).click();
  await expect(page.getByRole('dialog', { name: 'Plan evidence', exact: true })).toContainText('<script>attack()</script>');
  await expect(page.locator('dialog script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await selectStep(page, 'approve-plan');
  await page.getByRole('button', { name: 'Подтвердить план' }).click();
  const gate = page.getByRole('dialog', { name: 'Подтвердите решение' });
  await expect(gate).toContainText('workspace.source.write');
  await gate.getByRole('checkbox', { name: /проверил границы задачи/ }).check();
  await gate.getByRole('button', { name: 'Зафиксировать решение' }).click();

  await expect.poll(() => fixture.calls.filter((call) => call.action === 'gate').length).toBe(1);
  const gateBody = fixture.calls.find((call) => call.action === 'gate').body;
  expect(gateBody.permissions).toEqual(['workspace.source.write']);
  expect(gateBody.challenge).toBe('challenge-fixture');
  expect(gateBody.nodeId).toBe('approve-plan');
  expect(gateBody.expectedRevision).toBe(3);
  expect(gateBody.planHash).toBe(fixture.current().planHash);

  await selectStep(page, 'implement');
  await stepDetails(page).getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Повторить тот же запрос' })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить тот же запрос' }).click();
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'run').length).toBe(2);
  const runBodies = fixture.calls.filter((call) => call.action === 'run').map((call) => call.body);
  expect(runBodies[0].operationId).toBe(runBodies[1].operationId);
  expect(runBodies[1]).toEqual(runBodies[0]);
  expect(runBodies[0].nodeId).toBe('implement');
  expect(runBodies[0].planHash).toBe(gateBody.planHash);
});

test('creates a task from ordinary text without ids, permissions or external calls', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { emptyUntilIntake: true });
  await page.goto(`/#session=${token}`);
  await newQuest(page);
  const composer = page.getByRole('dialog', { name: 'Новое поручение', exact: true });
  await expect(composer).toBeVisible();
  await expect(page.getByText('flowcairn task --file task.json')).toHaveCount(0);
  await expect(page.getByLabel('ID зарегистрированной задачи')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: 'Начать анализ', exact: true })).toBeDisabled();
  await composer.getByLabel('Название', {exact:true}).fill('Исправить поиск');
  await composer.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await composer.getByLabel('Что нужно сделать', {exact:true}).fill('Исправить поиск и добавить проверку пустого ввода');
  await composer.getByRole('button', { name: 'Начать анализ', exact: true }).click();
  await openDiagnostics(page, 'nodes');
  await expect(stepPicker(page)).toBeVisible();
  const request = fixture.calls.find(call => call.action === 'intake').body;
  expect(Object.keys(request).sort()).toEqual(['contextHash', 'description', 'operationId', 'taskNumber', 'title']);
  expect(request.contextHash).toBe(projectContext.contextHash);
  expect(fixture.calls.filter(call => call.action === 'run' || call.action === 'gate')).toHaveLength(0);
});

test('shows the user task number in the journal and task context', async ({ page }) => {
  await mockApi(page, snapshot());
  await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  await expect(journal.locator('.journal-entry').first()).toContainText('FORM-101');
  await expect(journal.locator('.journal-entry').first()).not.toContainText('TASK-101');
  await selectRun(page, 'FORM-101');
  await expect(book(page).getByRole('article', { name: 'Обзор задачи' }).locator('.task-number')).toHaveText('FORM-101');
});

test('keeps the newest plan in the journal when an older run becomes stale later', async ({ page }) => {
  const stale = snapshot();
  stale.runId = 'run-old';
  stale.planVersion = 4;
  stale.status = 'stale';
  stale.updatedAt = '2026-09-14T12:30:00.000Z';
  stale.task = { ...stale.task, id: 'task-form-102', taskNumber: 'FORM-102' };
  const latest = {
    ...stale,
    runId: 'run-new',
    planVersion: 5,
    status: 'waiting-for-human',
    updatedAt: '2026-09-14T12:00:00.000Z',
  };
  latest.nodes = latest.nodes.map(node => ({ ...node, title: 'Этап актуального плана' }));
  await mockApi(page, stale, { extraRuns: [runSummary(latest)] });
  await page.route('**/api/runs/run-new/snapshot', route => route.fulfill({ json: latest }));
  await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  await expect(journal.locator('.journal-entry')).toHaveCount(1);
  await expect(journal).toContainText('FORM-102');
  await expect(journal).toContainText('Версия плана: 5');
  await expect(journal).not.toContainText('Версия плана: 4');
  await selectRun(page, 'FORM-102', 'nodes');
  await expect(stepPicker(page).locator('option:checked')).toContainText('Этап актуального плана');
});

test('replays a lost intake response with the exact same request', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { loseFirstCreateResponse: true, loseFirstRunResponse: false });
  await page.goto(`/#session=${token}`);
  await newQuest(page);
  const composer = page.getByRole('dialog', { name: 'Новое поручение', exact: true });
  await composer.getByLabel('Название', {exact:true}).fill('Исправить поиск');
  await composer.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await composer.getByLabel('Что нужно сделать', {exact:true}).fill('Проверить стабильный intake');
  await composer.getByRole('button', { name: 'Начать анализ', exact: true }).click();
  await expect(composer.getByRole('alert')).toContainText('Результат операции неизвестен');
  await expect(composer.getByLabel('Что нужно сделать', {exact:true})).toBeDisabled();
  await expect(composer.getByRole('button', {name:'Закрыть свиток', exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(composer.getByLabel('Что нужно сделать', {exact:true})).toHaveValue('Проверить стабильный intake');
  await composer.getByRole('button', { name: 'Повторить тот же запрос' }).click();
  await expect(composer).toHaveCount(0);
  const requests = fixture.calls.filter(call => call.action === 'intake').map(call => call.body);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('does not let a delayed snapshot replace a newer revision', async ({ page }) => {
  const fixture = await mockApi(page, runnableSnapshot(), {
    loseFirstRunResponse: false,
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await expect((await version(page)).getByTestId('run-revision')).toHaveText('3');

  const held = fixture.holdNextSnapshot();
  await held.captured;
  await selectStep(page, 'implement');
  await stepDetails(page).getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('4');

  held.release();
  await page.waitForTimeout(250);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('4');

  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByText('r4', { exact: true })).toBeVisible();
});

test('coalesces rapid toolbar clicks before React rerenders', async ({ page }) => {
  const fixture = await mockApi(page, runnableSnapshot(), {
    loseFirstRunResponse: false,
    runDelayMs: 300,
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');

  await selectStep(page, 'implement');
  const button = stepDetails(page).getByRole('button', { name: 'Запустить', exact: true });
  await expect(button).toBeVisible();
  await button.evaluate((element) => {
    element.click();
    element.click();
  });

  await expect.poll(() => fixture.calls.filter((call) => call.action === 'run').length).toBe(1);
  await page.waitForTimeout(400);
  expect(fixture.calls.filter((call) => call.action === 'run')).toHaveLength(1);
});

test('sends Stop while a long Run request is still pending', async ({ page }) => {
  const fixture = await mockApi(page, runnableSnapshot(), {
    exposeRunningBeforeRunResponse: true,
    loseFirstRunResponse: false,
    runDelayMs: 3500,
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await version(page);
  await book(page).locator('.diagnostic-tools').getByRole('button', { name: 'Запустить', exact: true }).click();

  const stop = book(page).getByRole('button', { name: 'Остановить', exact: true });
  await expect(stop).toBeEnabled({ timeout: 3000 });
  await stop.click();
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'stop').length).toBe(1);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('5');

  await page.waitForTimeout(1800);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('5');
  expect(fixture.calls.filter((call) => call.action === 'run')).toHaveLength(1);
});

test('shows stopping immediately and keeps it after the control response', async ({ page }, testInfo) => {
  const current = runnableSnapshot();
  current.status = 'running';
  current.execution = { state: 'running', stopRequested: false };
  current.capabilities = { ...allDenied, stop: allowed };
  const fixture = await mockApi(page, current, { stopDelayMs: 600 });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');

  await page.getByRole('button', { name: 'Остановить', exact: true }).click();

  const status = page.locator('.execution-status');
  await expect(status).toContainText('Останавливаем процесс');
  await expect(page.getByRole('button', { name: 'Останавливаем…', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('stopping.png') });
  await page.waitForTimeout(700);
  await expect(status).toContainText('Останавливаем процесс');
  expect(fixture.calls.filter((call) => call.action === 'stop')).toHaveLength(1);
});

test('distinguishes confirmed stop from unconfirmed termination', async ({ page }, testInfo) => {
  const current = runnableSnapshot();
  current.status = 'uncertain';
  current.execution = { state: 'stopped', stopRequested: true };
  current.capabilities = allDenied;
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');

  const status = page.locator('.execution-status');
  await expect(status).toContainText('Процесс остановлен');
  await page.screenshot({ path: testInfo.outputPath('stopped.png') });
  fixture.current().execution = { state: 'stop-uncertain', stopRequested: true };
  fixture.current().revision += 1;
  await expect(status).toContainText('Не удалось подтвердить остановку');
  await expect(status).toHaveAttribute('role', 'alert');
});

test('refreshes snapshot when the stop response is lost', async ({ page }) => {
  const current = runnableSnapshot();
  current.status = 'running';
  current.execution = { state: 'running', stopRequested: false };
  current.capabilities = { ...allDenied, stop: allowed };
  const fixture = await mockApi(page, current, { loseStopResponse: true });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');
  const reads = fixture.snapshotReads();

  await page.getByRole('button', { name: 'Остановить', exact: true }).click();

  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.getByText('Проверяем, была ли принята команда…')).toHaveCount(0);
  await expect(page.locator('.execution-status')).toContainText('Останавливаем процесс');
  expect(fixture.calls.filter((call) => call.action === 'stop')).toHaveLength(1);
});

test('does not claim stop acceptance when both stop response and snapshot are unavailable', async ({ page }) => {
  const current = runnableSnapshot();
  current.status = 'running';
  current.execution = { state: 'running', stopRequested: false };
  current.capabilities = { ...allDenied, stop: allowed };
  const fixture = await mockApi(page, current, { loseStopResponse: true });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');
  const stop = page.getByRole('button', { name: 'Остановить', exact: true });
  await expect(stop).toBeVisible();
  await page.route('**/snapshot', (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'NETWORK_UNCERTAIN', message: 'snapshot unavailable' } },
  }));

  await stop.click();

  const error = page.getByRole('alert').filter({ hasText: 'Не удалось подтвердить, принята ли команда остановки' });
  await expect(error).toBeVisible();
  await expect(error.getByRole('button', { name: 'Повторить тот же запрос' })).toHaveCount(0);
  expect(fixture.calls.filter((call) => call.action === 'stop')).toHaveLength(1);
});

test('clears a stale Stop request after revision conflict before allowing a new Stop', async ({
  page,
}) => {
  const current = runnableSnapshot();
  current.status = 'running';
  current.capabilities = { ...allDenied, stop: allowed };
  const fixture = await mockApi(page, current, { stopConflictFirst: true });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');
  const initialSnapshotReads = fixture.snapshotReads();

  const stop = page.getByRole('button', { name: 'Остановить', exact: true });
  await stop.click();
  await expect(page.getByRole('alert')).toContainText('Задача уже обновилась');
  await expect(page.getByRole('button', { name: 'Повторить тот же запрос' })).toHaveCount(0);
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(initialSnapshotReads);
  expect(fixture.calls.filter((call) => call.action === 'stop')).toHaveLength(1);

  await stop.click();
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'stop').length).toBe(2);
  const requests = fixture.calls.filter((call) => call.action === 'stop').map((call) => call.body);
  expect(requests[1].operationId).not.toBe(requests[0].operationId);
});

test('accepts a validated replan successor and resets run-scoped state', async ({ page }) => {
  const fixture = await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByText('r3', { exact: true })).toBeVisible();
  await openDiagnostics(page, 'plan');
  await page.getByRole('button', { name: 'Новая версия плана' }).click();
  const draft = page.getByRole('dialog', { name: 'Черновик новой версии' });
  await draft.getByRole('button', { name: 'Отправить на серверную проверку' }).click();

  await version(page);
  await expect(book(page).locator('.diagnostic-version').getByTestId('plan-version')).toHaveText('2');
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('0');
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByText('r0', { exact: true })).toBeVisible();
  await expect(page.getByText('r3', { exact: true })).toHaveCount(0);
  expect(fixture.current().supersedesRunId).toBe('run-demo');
  await expect(page.getByText(/INVALID_SNAPSHOT/)).toHaveCount(0);
});

test('loads immutable plan even when the initial snapshot becomes stale', async ({ page }) => {
  await mockApi(page, snapshot(), {
    advanceAfterFirstSnapshot: true,
    eventsDelayMs: 3500,
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await version(page);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('4', { timeout: 6000 });
  await page.getByRole('tab', { name: 'План' }).click();
  await expect(page.getByRole('heading', { name: 'План v1' })).toBeVisible();
});

test('ignores a delayed comparison response for a previous selection', async ({ page }) => {
  const current = snapshot();
  const runB = runSummary({ ...current, runId: 'run-b' });
  const runC = runSummary({ ...current, runId: 'run-c' });
  await mockApi(page, current, {
    extraRuns: [runB, runC],
    planResponses: {
      'run-b': {
        delayMs: 700,
        plan: {
          ...structuredClone(plan),
          nodes: [...plan.nodes, { ...plan.nodes[0], id: 'only-b' }],
        },
      },
      'run-c': {
        delayMs: 30,
        plan: {
          ...structuredClone(plan),
          nodes: [...plan.nodes, { ...plan.nodes[0], id: 'only-c' }],
        },
      },
    },
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await page.getByRole('tab', { name: 'План' }).click();
  const comparison = page.getByRole('combobox');
  await comparison.selectOption('run-b');
  await expect(page.locator('.plan-diff')).toContainText('Загружаем план для сравнения');
  await expect(page.locator('.plan-diff')).not.toContainText('Структура планов совпадает');
  await comparison.selectOption('run-c');

  await expect(page.locator('.plan-diff')).toContainText('+ only-c');
  await page.waitForTimeout(750);
  await expect(page.locator('.plan-diff')).toContainText('+ only-c');
  await expect(page.locator('.plan-diff')).not.toContainText('only-b');
});

test('uses native modal lifecycle and keeps toolbar keyboard activation', async ({ page }) => {
  const fixture = await mockApi(page, runnableSnapshot(), { loseFirstRunResponse: false });
  await page.goto(`/#session=${token}`);

  const journal = await openJournal(page);
  const create = journal.getByRole('button', { name: 'Новое поручение', exact: true });
  await create.focus();
  await create.click();
  const createDialog = page.getByRole('dialog', { name: 'Новое поручение', exact: true });
  await expect(createDialog).toBeVisible();
  expect(await createDialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(createDialog.locator('[data-overlay-heading]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(createDialog.getByRole('button', { name: 'Закрыть свиток', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(createDialog.getByLabel('Название', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Журнал', exact: true })).toBeFocused();

  await openDiagnostics(page, 'nodes');
  await selectStep(page, 'implement');
  const toolbarRun = stepDetails(page).getByRole('button', { name: 'Запустить', exact: true });
  await toolbarRun.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'run').length).toBe(1);
});

test('draft and evidence dialogs are modal, closable with Escape, and labelled', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'plan');

  await page.getByRole('button', { name: 'Новая версия плана' }).click();
  const draft = page.getByRole('dialog', { name: 'Черновик новой версии' });
  expect(await draft.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(draft.getByRole('textbox', { name: 'JSON nodes новой версии' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(draft).toHaveCount(0);

  await openDiagnostics(page, 'evidence');
  await page.getByRole('button', { name: /Plan evidence/ }).click();
  const evidence = page.getByRole('dialog', { name: 'Plan evidence' });
  expect(await evidence.evaluate((element) => element.matches(':modal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(evidence).toHaveCount(0);
});

test('fallback polling is single-flight', async ({ page }) => {
  const options = {};
  const fixture = await mockApi(page, snapshot(), options);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await version(page);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('3');
  options.snapshotDelayMs = 2500;

  await page.waitForTimeout(5200);
  expect(fixture.maxSnapshotReads()).toBe(1);
});

test('coalesces SSE bursts and polling into one snapshot request', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), {
    snapshotDelayAfterFirstMs: 2500,
    streamBurst: [4, 5, 6],
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await version(page);

  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('6', { timeout: 6000 });
  expect(fixture.maxSnapshotReads()).toBe(1);
  expect(fixture.snapshotReads()).toBe(2);
});

test('accepts a fail-closed snapshot without revision and stops catch-up', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), {
    failClosedSnapshotAfterFirst: true,
    streamBurst: [4],
  });
  await page.goto(`/#session=${token}`);

  await openDiagnostics(page, 'nodes');
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Состояние недоступно');
  await version(page);
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('—');
  await expect(stepPicker(page).locator('option')).toHaveCount(1);
  await expect(book(page).getByRole('button', { name: 'Запустить', exact: true })).toHaveCount(0);
  await openDiagnostics(page, 'result');
  await expect(book(page).locator('.workflow-summary')).toHaveText('Целостность данных не подтверждена');
  await page.waitForTimeout(500);
  expect(fixture.snapshotReads()).toBe(2);
  expect(fixture.maxSnapshotReads()).toBe(1);
});

test('does not run two-second list polling while SSE is connected', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes('/stream?')) {
        return Promise.resolve(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      }
      return originalFetch(input, init);
    };
  });
  const fixture = await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await expect(book(page).getByText('На связи', { exact: true })).toBeVisible();
  const initialReads = fixture.listReads();

  await page.waitForTimeout(2500);
  expect(fixture.listReads()).toBe(initialReads);
});

test('explicit refresh discovers a run from an initially empty list', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyFirstList: true });
  await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  await expect(journal).toContainText('Здесь появятся ваши поручения');
  await journal.getByRole('button', { name: 'Обновить журнал', exact: true }).click();
  await expect(journal.locator('.journal-entry', { hasText: 'FORM-101' })).toBeVisible();
});

test('dark status text tokens meet 4.5 to 1 contrast', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await book(page).getByRole('button', { name: 'Сменить тему' }).click();
  const ratios = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.diagnostic-paper'));
    const parse = (value) => {
      const normalized = value.trim().replace('#', '');
      return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
    };
    const luminance = (value) =>
      value
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const background = luminance(parse(style.getPropertyValue('--surface')));
    return [
      'pending',
      'ready',
      'running',
      'waiting-for-human',
      'passed',
      'failed',
      'uncertain',
      'stale',
    ].map((status) => {
      const foreground = luminance(parse(style.getPropertyValue(`--status-${status}`)));
      return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
    });
  });
  expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
});

test('opens eleven mobile steps on the active step and keeps every step and dependency accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const current = chainSnapshot({ activeNodeId: 'node-5', status: 'running' });
  current.nodes[5] = { ...current.nodes[5], status: 'running' };
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await expect(stepPicker(page).locator('option')).toHaveCount(12);
  await expect(stepPicker(page).locator('option').filter({ hasText: 'Выполняется' })).toHaveCount(1);
  await readableStep(page, 'Этап 6');
  for (const node of current.nodes) {
    await selectStep(page, node.id);
    await readableStep(page, node.title);
    await expect(stepDetails(page)).toHaveAttribute('data-node-id', node.id);
    if (node.needs.length) await expect(stepDetails(page).locator('.fact-list')).toContainText(node.needs[0]);
  }
  await book(page).getByRole('button', { name: 'Текущий этап', exact: true }).click();
  await readableStep(page, 'Этап 6');
  expect(fixture.calls).toHaveLength(0);
});

test('mobile focuses active, waiting, failed, and completed nodes again on run switch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const active = chainSnapshot({
    runId: 'run-active',
    activeNodeId: 'node-5',
    status: 'running',
    task: { ...snapshot().task, id: 'TASK-ACTIVE', taskNumber: 'TASK-ACTIVE' },
  });
  active.nodes[5] = { ...active.nodes[5], status: 'running' };
  const waiting = chainSnapshot({
    runId: 'run-waiting',
    activeNodeId: null,
    status: 'waiting-for-human',
    task: { ...snapshot().task, id: 'TASK-WAITING', taskNumber: 'TASK-WAITING' },
  });
  waiting.nodes[3] = { ...waiting.nodes[3], status: 'waiting-for-human' };
  waiting.gates = [{ ...snapshot().gates[0], nodeId: 'node-3' }];
  const failed = chainSnapshot({
    runId: 'run-failed',
    activeNodeId: null,
    gates: [],
    status: 'failed',
    finalDisposition: null,
    task: { ...snapshot().task, id: 'TASK-FAILED', taskNumber: 'TASK-FAILED' },
  });
  failed.nodes[4] = { ...failed.nodes[4], status: 'failed' };
  const completed = chainSnapshot({
    runId: 'run-completed',
    activeNodeId: null,
    gates: [],
    status: 'passed',
    finalDisposition: 'accepted',
    task: { ...snapshot().task, id: 'TASK-COMPLETED', taskNumber: 'TASK-COMPLETED' },
  });
  completed.nodes = completed.nodes.map((node) => ({ ...node, status: 'passed' }));
  const snapshots = new Map(
    [active, waiting, failed, completed].map((value) => [value.runId, value]),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    expect(request.headers()['x-flowcairn-control']).toBe(token);
    const url = new URL(request.url());
    if (url.pathname === '/api/project') { await route.fulfill({ json: projectContext }); return; }
    if (url.pathname === '/api/runs') {
      await route.fulfill({
        json: {
          runs: [active, waiting, failed, completed].map(runSummary),
          capabilities: { create: allowed },
        },
      });
      return;
    }
    if (url.pathname.endsWith('/stream')) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    const runId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    if (url.pathname.endsWith('/snapshot')) {
      await route.fulfill({ json: snapshots.get(runId) });
      return;
    }
    if (url.pathname.endsWith('/plan')) {
      await route.fulfill({ json: plan });
      return;
    }
    if (url.pathname.endsWith('/events')) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });

  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await readableStep(page, 'Этап 6');
  await selectRun(page, 'TASK-WAITING', 'nodes');
  await readableStep(page, 'Этап 4');
  await selectRun(page, 'TASK-FAILED', 'nodes');
  await readableStep(page, 'Этап 5');
  await selectStep(page, 'node-0');
  await readableStep(page, 'Этап 1');
  await page.getByRole('button', { name: 'Текущий этап' }).click();
  await readableStep(page, 'Этап 5');
  await selectRun(page, 'TASK-COMPLETED', 'nodes');
  await readableStep(page, 'Этап 11');
});

test('polling revision and locale changes preserve the selected diagnostic step', async ({ page }) => {
  const current = chainSnapshot({ activeNodeId: 'node-5', status: 'running' });
  current.nodes[5] = { ...current.nodes[5], status: 'running' };
  await mockApi(page, current, { advanceAfterFirstSnapshot: true });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await book(page).getByRole('button', { name: 'Текущий этап', exact: true }).click();
  await readableStep(page, 'Этап 6');
  await selectStep(page, 'node-8');
  await version(page);
  await book(page).getByRole('button', { name: 'На английском' }).click();
  await expect(stepPicker(page)).toHaveValue('node-8');
  await expect(book(page).getByRole('tab', { name: 'Steps', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(book(page).locator('.diagnostic-version').getByTestId('run-revision')).toHaveText('4', { timeout: 5000 });
  await expect(stepDetails(page)).toHaveAttribute('data-node-id', 'node-8');
  await readableStep(page, 'Этап 9');
});

test('keeps the journal bounded and selected step readable on tablet with many runs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 618 });
  const current = snapshot();
  const extraRuns = Array.from({ length: 8 }, (_, index) =>
    runSummary({
      ...current,
      runId: `run-tablet-${index}`,
      task: { ...current.task, id: `TASK-TABLET-${index}`, taskNumber: `TASK-TABLET-${index}` },
    }),
  );
  await mockApi(page, current, { extraRuns });
  await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  await expect(journal.locator('.journal-entry')).toHaveCount(9);
  const layout = await journal.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.clientHeight).toBeLessThan(layout.scrollHeight);
  const last = journal.locator('.journal-entry').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await selectRun(page, 'FORM-101', 'nodes');
  await readableStep(page, 'Проверка плана');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reduced motion disables diagnostic execution animation and keeps the active step readable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = runnableSnapshot();
  current.status = 'running';
  current.activeNodeId = 'implement';
  current.nodes[1] = { ...current.nodes[1], status: 'running' };
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'result');
  const loader = book(page).locator('.status-loader-mark');
  await expect(loader).toHaveCount(1);
  const motion = await loader.evaluate(element => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(motion.animation).toBe('none');
  expect(motion.transition).toBe('0s');
  await selectStep(page, 'implement');
  await expect(stepDetails(page).locator('.status-chip')).toHaveClass(/status-running/);
});

test('clears an expired gate request and refreshes capabilities', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { gateErrorCode: 'GATE_EXPIRED' });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  const readsBeforeGate = fixture.snapshotReads();

  await page.getByRole('button', { name: 'Подтвердить план' }).click();
  const gate = page.getByRole('dialog', { name: 'Подтвердите решение' });
  await gate.getByRole('checkbox', { name: /проверил границы задачи/ }).check();
  await gate.getByRole('button', { name: 'Зафиксировать решение' }).click();

  const error = page.getByRole('alert');
  await expect(error).toContainText('Подтверждение устарело');
  await expect(error.getByRole('button', { name: 'Повторить тот же запрос' })).toHaveCount(0);
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(readsBeforeGate);
});

test('does not fetch data without a launch URL session', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/**', async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Нет локальной сессии управления' }),
  ).toBeVisible();
  await expect(page.getByText(/flowcairn ui --root PROJECT/)).toBeVisible();
  expect(requests).toBe(0);
});

test('renders a fail-closed snapshot when optional evidence reads fail', async ({ page }) => {
  const corrupt = {
    schemaVersion: 2,
    runId: 'run-corrupt',
    status: 'stale',
    integrity: { valid: false, reason: 'Целостность данных не подтверждена' },
    nodes: [],
    edges: [],
    gates: [],
    capabilities: allDenied,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    expect(request.headers()['x-flowcairn-control']).toBe(token);
    const url = new URL(request.url());
    if (url.pathname === '/api/project') { await route.fulfill({ json: projectContext }); return; }
    if (url.pathname.endsWith('/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    if (url.pathname === '/api/runs') {
      await route.fulfill({
        json: {
          runs: [runSummary(corrupt)],
          capabilities: { create: allowed },
        },
      });
      return;
    }
    if (url.pathname.endsWith('/snapshot')) {
      await route.fulfill({ json: corrupt });
      return;
    }
    await route.fulfill({
      status: 500,
      json: { error: { code: 'STORE_CORRUPT', message: 'unavailable' } },
    });
  });
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Состояние недоступно');
  await expect(book(page).getByRole('heading', { name: 'Книга диагностики', exact: true })).toBeVisible();
  await expect(stepPicker(page).locator('option')).toHaveCount(1);
  await expect(stepDetails(page)).toHaveCount(0);
  await expect(book(page).getByRole('button', { name: 'Запустить', exact: true })).toHaveCount(0);
  await openDiagnostics(page, 'result');
  await expect(book(page).locator('.workflow-summary')).toHaveText('Целостность данных не подтверждена');
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('keeps controls usable on mobile and supports RU/EN and dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  await book(page).getByRole('button', { name: 'На английском' }).click();
  await expect(book(page).getByRole('heading', { name: 'Diagnostic book', exact: true })).toBeVisible();
  expect(await page.locator('html').getAttribute('lang')).toBe('en');
  await page.getByRole('button', { name: 'Switch theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-dark', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('actual service fixture smoke', async ({ page }, testInfo) => {
  test.skip(!process.env.FLOWCAIRN_TEST_URL, 'FLOWCAIRN_TEST_URL is not set');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(process.env.FLOWCAIRN_TEST_URL);
  await expect(
    page.getByRole('heading', {
      name: 'Flowcairn', exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId('rpg-shell')).toBeVisible();
  await openDiagnostics(page, 'nodes');
  await expect(stepPicker(page).locator('option').nth(1)).toBeAttached();
  await book(page).getByRole('button', { name: 'Текущий этап', exact: true }).click();
  await expect(stepDetails(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('actual-workflow.png'), fullPage: true });
});
