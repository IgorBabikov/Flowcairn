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

async function readableInGraph(page, title) {
  const node = page.locator('.graph-node', { hasText: title });
  await expect(node).toBeAttached();
  await expect
    .poll(async () => {
      const box = await node.boundingBox();
      const viewport = await page.locator('.react-flow').boundingBox();
      return Boolean(
        box &&
        viewport &&
        box.width >= 215 &&
        box.x >= viewport.x - 1 &&
        box.x + box.width <= viewport.x + viewport.width + 1 &&
        box.y >= viewport.y - 1 &&
        box.y + box.height <= viewport.y + viewport.height + 1,
      );
    })
    .toBe(true);
}

async function openGraph(page) {
  await page.getByRole('button', { name: 'Граф', exact: true }).click();
  await page.getByRole('button', { name: 'Детали исполнения', exact: true }).click();
  const closeDetails = page.getByRole('button', { name: 'Закрыть детали', exact: true });
  if (page.viewportSize().width < 1180 && await closeDetails.isVisible()) await closeDetails.click();
}

async function selectMobileRun(page, name) {
  await page.getByRole('button', { name: 'Показать запуски', exact: true }).click();
  await page.getByRole('dialog', { name: 'Запуски', exact: true }).getByRole('button', { name }).click();
  const closeDetails = page.getByRole('button', { name: 'Закрыть детали', exact: true });
  if (page.viewportSize().width < 1180 && await closeDetails.isVisible()) await closeDetails.click();
}

test('renders backend state, confirms a gate, and retries one operation id', async ({ page }) => {
  const fixture = await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openGraph(page);

  await expect(page.getByRole('heading', { name: 'flowcairn' })).toBeVisible();
  await expect(page.locator('.node-mode', { hasText: 'Чтение' })).toBeVisible();
  await expect(page.locator('.node-mode', { hasText: 'Запись' })).toBeVisible();
  await expect(page.getByText('project-context · 11111111')).toBeVisible();
  expect(page.url()).not.toContain('session=');
  expect(await page.evaluate(() => sessionStorage.getItem('flowcairn.graph.session'))).toBe(token);

  await page.getByRole('tab', { name: 'Результаты' }).click();
  await page.getByRole('button', { name: /Plan evidence/ }).click();
  await expect(page.getByRole('dialog')).toContainText('<script>attack()</script>');
  await expect(page.locator('dialog script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await page.getByRole('tab', { name: 'Обзор' }).click();
  await page.getByRole('button', { name: 'Подтвердить план' }).click();
  const gate = page.getByRole('dialog', { name: 'Подтвердите решение' });
  await expect(gate).toContainText('workspace.source.write');
  await gate.getByRole('checkbox', { name: /проверил границы задачи/ }).check();
  await gate.getByRole('button', { name: 'Зафиксировать решение' }).click();

  await expect.poll(() => fixture.calls.filter((call) => call.action === 'gate').length).toBe(1);
  const gateBody = fixture.calls.find((call) => call.action === 'gate').body;
  expect(gateBody.permissions).toEqual(['workspace.source.write']);
  expect(gateBody.challenge).toBe('challenge-fixture');

  await page.getByRole('button', { name: /Внесение изменений/ }).click();
  await page.getByRole('button', { name: 'Запустить', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Повторить тот же запрос' })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить тот же запрос' }).click();
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'run').length).toBe(2);
  const runBodies = fixture.calls.filter((call) => call.action === 'run').map((call) => call.body);
  expect(runBodies[0].operationId).toBe(runBodies[1].operationId);
});

test('creates a task from ordinary text without ids, permissions or external calls', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { emptyUntilIntake: true });
  await page.goto(`/#session=${token}`);
  const composer = page.getByRole('region', { name: 'Новая задача' });
  await expect(composer).toBeVisible();
  await expect(page.getByText('flowcairn task --file task.json')).toHaveCount(0);
  await expect(page.getByLabel('ID зарегистрированной задачи')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await composer.getByLabel('Заголовок задачи', {exact:true}).fill('Исправить поиск');
  await composer.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await composer.getByLabel('Полное описание задачи', {exact:true}).fill('Исправить поиск и добавить проверку пустого ввода');
  await composer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await openGraph(page);
  await expect(page.locator('.react-flow')).toBeVisible();
  const request = fixture.calls.find(call => call.action === 'intake').body;
  expect(Object.keys(request).sort()).toEqual(['contextHash', 'description', 'operationId', 'taskNumber', 'title']);
  expect(request.contextHash).toBe(projectContext.contextHash);
  expect(fixture.calls.filter(call => call.action === 'run' || call.action === 'gate')).toHaveLength(0);
});

test('shows the user task number in the run rail and graph header', async ({ page }) => {
  await mockApi(page, snapshot());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.run-row').first()).toContainText('FORM-101');
  await expect(page.locator('.run-row').first()).not.toContainText('TASK-101');
  await expect(page.locator('.graph-goal summary')).toContainText('FORM-101');
});

test('keeps the newest plan in the rail when an older run becomes stale later', async ({ page }) => {
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
  await openGraph(page);
  const rail = page.locator('.run-list');
  await expect(rail).toContainText('FORM-102');
  await expect(rail).toContainText('Версия плана 5');
  await expect(rail).not.toContainText('Версия плана 4');
  await expect(page.locator('.graph-node').first()).toContainText('Этап актуального плана');
});

test('replays a lost intake response with the exact same request', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { loseFirstCreateResponse: true, loseFirstRunResponse: false });
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Новая задача' }).click();
  const composer = page.getByRole('region', { name: 'Новая задача' });
  await composer.getByLabel('Заголовок задачи', {exact:true}).fill('Исправить поиск');
  await composer.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await composer.getByLabel('Полное описание задачи', {exact:true}).fill('Проверить стабильный intake');
  await composer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(composer.getByRole('alert')).toContainText('Результат операции неизвестен');
  await expect(composer.getByLabel('Полное описание задачи', {exact:true})).toBeDisabled();
  await expect(composer.getByRole('button', {name:'Закрыть', exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(composer.getByLabel('Полное описание задачи', {exact:true})).toHaveValue('Проверить стабильный intake');
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
  await expect(page.getByTestId('run-revision')).toHaveText('3');
  await openGraph(page);

  const held = fixture.holdNextSnapshot();
  await held.captured;
  await page.getByRole('button', { name: /Внесение изменений/ }).click();
  await page.getByRole('button', { name: 'Запустить', exact: true }).last().click();
  await expect(page.getByTestId('run-revision')).toHaveText('4');

  held.release();
  await page.waitForTimeout(250);
  await expect(page.getByTestId('run-revision')).toHaveText('4');

  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByText('r4', { exact: true })).toBeVisible();
});

test('coalesces rapid toolbar clicks before React rerenders', async ({ page }) => {
  const fixture = await mockApi(page, runnableSnapshot(), {
    loseFirstRunResponse: false,
    runDelayMs: 300,
  });
  await page.goto(`/#session=${token}`);
  await openGraph(page);

  const node = page.locator('.graph-node', { hasText: 'Внесение изменений' });
  await node.click();
  const button = page.locator('.node-toolbar').getByRole('button', { name: 'Запустить' });
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
  await page.getByRole('button', { name: 'Запустить', exact: true }).first().click();

  const stop = page.getByRole('button', { name: 'Остановить', exact: true });
  await expect(stop).toBeEnabled({ timeout: 3000 });
  await stop.click();
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'stop').length).toBe(1);
  await expect(page.getByTestId('run-revision')).toHaveText('5');

  await page.waitForTimeout(1800);
  await expect(page.getByTestId('run-revision')).toHaveText('5');
  expect(fixture.calls.filter((call) => call.action === 'run')).toHaveLength(1);
});

test('shows stopping immediately and keeps it after the control response', async ({ page }, testInfo) => {
  const current = runnableSnapshot();
  current.status = 'running';
  current.execution = { state: 'running', stopRequested: false };
  current.capabilities = { ...allDenied, stop: allowed };
  const fixture = await mockApi(page, current, { stopDelayMs: 600 });
  await page.goto(`/#session=${token}`);

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
  await openGraph(page);
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByText('r3', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Обзор' }).click();
  await page.getByRole('button', { name: 'Новая версия плана' }).click();
  const draft = page.getByRole('dialog', { name: 'Черновик новой версии' });
  await draft.getByRole('button', { name: 'Отправить на серверную проверку' }).click();

  await expect(page.getByTestId('plan-version')).toHaveText('2');
  await expect(page.getByTestId('run-revision')).toHaveText('0');
  await page.getByRole('button',{name:'Детали исполнения',exact:true}).click();
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
  await openGraph(page);
  await expect(page.getByTestId('run-revision')).toHaveText('4', { timeout: 6000 });
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
  await openGraph(page);
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

  const create = page.getByRole('button', { name: 'Новая задача' });
  await create.focus();
  await create.click();
  const createDialog = page.getByRole('region', { name: 'Новая задача' });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel('Заголовок задачи', {exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(createDialog).toHaveCount(0);
  await expect(create).toBeFocused();

  await openGraph(page);
  await page.getByRole('button', { name: /Внесение изменений/ }).click();
  const toolbarRun = page.locator('.node-toolbar').getByRole('button', { name: 'Запустить' });
  await toolbarRun.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture.calls.filter((call) => call.action === 'run').length).toBe(1);
});

test('draft and evidence dialogs are modal, closable with Escape, and labelled', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await openGraph(page);

  await page.getByRole('button', { name: 'Новая версия плана' }).click();
  const draft = page.getByRole('dialog', { name: 'Черновик новой версии' });
  expect(await draft.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(draft.getByRole('textbox', { name: 'JSON nodes новой версии' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(draft).toHaveCount(0);

  await page.getByRole('tab', { name: 'Результаты' }).click();
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
  await expect(page.getByTestId('run-revision')).toHaveText('3');
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

  await expect(page.getByTestId('run-revision')).toHaveText('6', { timeout: 6000 });
  expect(fixture.maxSnapshotReads()).toBe(1);
  expect(fixture.snapshotReads()).toBe(2);
});

test('accepts a fail-closed snapshot without revision and stops catch-up', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), {
    failClosedSnapshotAfterFirst: true,
    streamBurst: [4],
  });
  await page.goto(`/#session=${token}`);

  await page.getByRole('button',{name:'Состояние проекта',exact:true}).click();
  await expect(page.locator('.run-health .negative')).toHaveText('Целостность данных не подтверждена');
  await expect(page.getByTestId('run-revision')).toHaveText('—');
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
  await expect(page.getByText('На связи')).toBeVisible();
  const initialReads = fixture.listReads();

  await page.waitForTimeout(2500);
  expect(fixture.listReads()).toBe(initialReads);
});

test('explicit refresh discovers a run from an initially empty list', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyFirstList: true });
  await page.goto(`/#session=${token}`);
  await expect(page.getByRole('region', { name: 'Новая задача' })).toBeVisible();
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByRole('button', { name: /FORM-101/ })).toBeVisible();
});

test('dark status text tokens meet 4.5 to 1 contrast', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Сменить тему' }).click();
  const ratios = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
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

test('opens an eleven-node mobile graph on a readable active node and keeps fit-all overview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const current = chainSnapshot({ activeNodeId: 'node-5', status: 'running' });
  current.nodes[5] = { ...current.nodes[5], status: 'running' };
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.graph-node.status-running')).toHaveCount(1);
  await expect(page.locator('.react-flow__minimap')).toBeHidden();
  await readableInGraph(page, 'Этап 6');

  await page.getByRole('button', { name: 'Весь граф', exact: true }).click();
  await page.waitForTimeout(250);

  const contained = await page.evaluate(() => {
    const viewport = document.querySelector('.react-flow')?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.graph-node')].map((node) =>
      node.getBoundingClientRect(),
    );
    return Boolean(
      viewport &&
      nodes.length === 11 &&
      nodes.every(
        (node) =>
          node.left >= viewport.left - 1 &&
          node.right <= viewport.right + 1 &&
          node.top >= viewport.top - 1 &&
          node.bottom <= viewport.bottom + 1,
      ),
    );
  });
  expect(contained).toBe(true);

  await page.getByRole('button', { name: 'Текущий этап' }).click();
  await readableInGraph(page, 'Этап 6');
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
  await openGraph(page);
  await readableInGraph(page, 'Этап 6');
  await selectMobileRun(page, /TASK-WAITING/);
  await readableInGraph(page, 'Этап 4');
  await selectMobileRun(page, /TASK-FAILED/);
  await readableInGraph(page, 'Этап 5');
  await page.getByRole('button', { name: 'Весь граф', exact: true }).click();
  await expect
    .poll(
      async () => (await page.locator('.graph-node', { hasText: 'Этап 5' }).boundingBox())?.width,
    )
    .toBeLessThan(100);
  await page.getByRole('button', { name: 'Текущий этап' }).click();
  await readableInGraph(page, 'Этап 5');
  await selectMobileRun(page, /TASK-COMPLETED/);
  await readableInGraph(page, 'Этап 11');
});

test('polling revision and locale changes preserve the operator viewport', async ({ page }) => {
  const current = chainSnapshot({ activeNodeId: 'node-5', status: 'running' });
  current.nodes[5] = { ...current.nodes[5], status: 'running' };
  await mockApi(page, current, { advanceAfterFirstSnapshot: true });
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await page.getByRole('button', { name: 'Текущий этап', exact: true }).click();
  await readableInGraph(page, 'Этап 6');

  await page.getByRole('button', { name: 'Отдалить' }).click();
  await page.getByRole('button', { name: 'Отдалить' }).click();
  const viewport = page.locator('.react-flow__viewport');
  const before = await viewport.evaluate((element) => element.getAttribute('style'));
  await page.getByRole('button', { name: 'На английском' }).click();
  await expect(viewport).toHaveAttribute('style', before ?? '');
  await expect(page.getByTestId('run-revision')).toHaveText('4', { timeout: 5000 });
  await expect(viewport).toHaveAttribute('style', before ?? '');
});

test('keeps graph cards visible and run list bounded on tablet with many runs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 618 });
  const current = snapshot();
  const extraRuns = Array.from({ length: 8 }, (_, index) =>
    runSummary({
      ...current,
      runId: `run-tablet-${index}`,
      task: { ...current.task, id: `TASK-TABLET-${index}` },
    }),
  );
  await mockApi(page, current, { extraRuns });
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.run-row')).toHaveCount(9);
  await expect(page.locator('.graph-node').first()).toBeAttached();

  const layout = await page.evaluate(() => {
    const graph = document.querySelector('.graph-region')?.getBoundingClientRect();
    const node = document.querySelector('.graph-node')?.getBoundingClientRect();
    const list = document.querySelector('.run-list');
    return {
      graphTop: graph?.top ?? Infinity,
      nodeTop: node?.top ?? Infinity,
      viewportHeight: window.innerHeight,
      listClientHeight: list?.clientHeight ?? 0,
      listScrollHeight: list?.scrollHeight ?? 0,
    };
  });
  expect(layout.graphTop).toBeLessThan(layout.viewportHeight);
  expect(layout.nodeTop).toBeLessThan(layout.viewportHeight);
  expect(layout.listClientHeight).toBeLessThan(layout.listScrollHeight);
});

test('reduced motion disables graph animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = runnableSnapshot();
  current.activeNodeId = 'implement';
  current.nodes[1] = { ...current.nodes[1], status: 'running' };
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  const edge = page.locator('.react-flow__edge-path');
  await expect(edge).toHaveCount(1);
  const motion = await edge.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(motion.animation).toBe('none');
  expect(motion.transition).toBe('0s');
});

test('clears an expired gate request and refreshes capabilities', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { gateErrorCode: 'GATE_EXPIRED' });
  await page.goto(`/#session=${token}`);
  await openGraph(page);
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
  await page.getByRole('button',{name:'Граф',exact:true}).click();
  await page.getByRole('button',{name:'Состояние проекта',exact:true}).click();
  await expect(page.locator('.run-health .negative')).toHaveText('Целостность данных не подтверждена');
  await expect(page.getByRole('heading', { name: 'Граф выполнения' }).first()).toBeVisible();
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('keeps controls usable on mobile and supports RU/EN and dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'На английском' }).click();
  await expect(page.getByRole('heading', { name: 'flowcairn' })).toBeVisible();
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
      name: 'flowcairn',
    }),
  ).toBeVisible();
  await expect(page.locator('.operator-layout')).toBeVisible();
  const advancedGraph = page.getByRole('button', { name: 'Граф', exact: true });
  if (await advancedGraph.isVisible()) await advancedGraph.click();
  await expect(page.locator('.graph-node').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('actual-workflow.png'), fullPage: true });
});
