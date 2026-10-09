import { test, expect } from '@playwright/test';
import { snapshot, graphNode, implementationNode, allDenied, allowed, mockApi, token } from './fixtures.mjs';
import { book, stepPicker, stepDetails, closeSurface, openDiagnostics, openJournal, openQuest, visitResult } from './ui-paths.mjs';

function running() {
  const state = snapshot();
  state.workflow = 'autonomous'; state.phase = 'execution'; state.status = 'running';
  state.task.title = state.task.goal = 'Добавить форму регистрации компании';
  state.gates = []; state.activeNodeId = 'implement'; state.capabilities = { ...allDenied, stop: allowed };
  state.nodes = [graphNode({ status: 'passed', capabilities: allDenied }), { ...implementationNode, status: 'running' }];
  state.execution = { state: 'running' };
  return state;
}

for (const width of [1366, 390]) {
  test(`world navigation and project context remain readable after diagnostic navigation at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, running());
    await page.goto(`/#session=${token}`);
    const nav = page.getByRole('navigation', { name: 'Игровое меню' });
    await expect(nav).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const before = await nav.boundingBox();
    await expect(page.locator('.game-brand')).toContainText('Тестовый проект');
    await openDiagnostics(page, 'nodes');
    await expect(stepPicker(page)).toHaveValue('implement');
    await expect(stepDetails(page)).toHaveAttribute('data-node-id', 'implement');
    await openDiagnostics(page, 'result');
    await expect(book(page).getByRole('article', { name: 'Обзор задачи' })).toBeVisible();
    await closeSurface(page);
    await expect(nav).toBeVisible();
    expect((await nav.boundingBox()).y).toBe(before.y);
    await expect(page.locator('.game-brand')).toContainText('Тестовый проект');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('closing diagnostic book survives newer revisions; modal chapters fit and Escape restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockApi(page, running());
  await page.goto(`/#session=${token}`);
  const opener = page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Настройки', exact: true });
  await opener.focus();
  await openDiagnostics(page, 'result');
  const dialog = page.getByRole('dialog', { name: 'Книга диагностики', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  for (const tab of await book(page).getByRole('tab').all()) {
    await tab.scrollIntoViewIfNeeded();
    const box = await tab.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThan(0); expect(box.y + box.height).toBeLessThan(844);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await expect(book(page).getByRole('tab', { name: 'План', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  const reads = fixture.snapshotReads(); fixture.current().revision += 1;
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(dialog).toHaveCount(0);
  await openDiagnostics(page, 'result');
  await book(page).getByRole('tab', { name: 'Результат', exact: true }).press('ArrowRight');
  await expect(book(page).getByRole('tab', { name: 'Этапы', exact: true })).toBeFocused();
  await expect(book(page).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'diagnostic-tab-nodes');
  await book(page).getByRole('tab', { name: 'Этапы', exact: true }).press('ArrowRight');
  await expect(book(page).getByRole('tab', { name: 'Отчеты', exact: true })).toBeFocused();
  await expect(book(page).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'diagnostic-tab-evidence');
  await book(page).getByRole('tab', { name: 'Отчеты', exact: true }).press('End');
  await expect(book(page).getByRole('tab', { name: 'История', exact: true })).toBeFocused();
  await book(page).getByRole('tab', { name: 'История', exact: true }).press('Home');
  await expect(book(page).getByRole('tab', { name: 'Результат', exact: true })).toBeFocused();
  await book(page).getByRole('tab', { name: 'Результат', exact: true }).press('ArrowLeft');
  await expect(book(page).getByRole('tab', { name: 'История', exact: true })).toBeFocused();
});

test('mobile user can start a second task from journal and return to the opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, running()); await page.goto(`/#session=${token}`);
  const opener = page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Журнал', exact: true });
  const journal = await openJournal(page);
  await journal.getByRole('button', { name: 'Новое поручение', exact: true }).click();
  const intake = page.getByRole('dialog', { name: 'Новое поручение', exact: true });
  await expect(intake.locator('[data-overlay-heading]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(intake.getByRole('button', { name: 'Закрыть свиток', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(intake.getByLabel('Название', { exact: true })).toBeFocused();
  await expect(journal).toHaveCount(0);
  await intake.getByRole('button', { name: 'Закрыть свиток', exact: true }).click();
  await expect(opener).toBeFocused();
});

test('unavailable snapshot never displays old health as current', async ({ page }) => {
  await mockApi(page, running(), { failClosedSnapshotAfterFirst: true });
  await visitResult(page);
  await book(page).getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Состояние недоступно');
  await expect(book(page).getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(book(page).locator('.task-progress')).toHaveCount(0);
  await expect(book(page).locator('.execution-status')).toHaveCount(0);
  await expect(book(page).getByRole('button', { name: 'Остановить', exact: true })).toHaveCount(0);
});

test('uncertain task exposes only executor-authorized recovery', async ({ page }) => {
  const state = running(); state.status = 'uncertain'; state.execution = { state: 'stop-uncertain' };
  state.capabilities = allDenied;
  state.nodes[1] = { ...state.nodes[1], status: 'uncertain', capabilities: { ...allDenied, recover: allowed } };
  const fixture = await mockApi(page, state); await visitResult(page);
  await book(page).getByRole('button', { name: 'Проверить остановку', exact: true }).click();
  const request = fixture.calls.find(call => call.action === 'recover');
  expect(request.body.nodeId).toBe('implement'); expect(request.body.expectedRevision).toBe(3);
  expect(request.body.planHash).toBe(state.planHash);
});

test('denied recovery offers reports without inventing a permission', async ({ page }) => {
  const state = running(); state.status = 'uncertain'; state.execution = { state: 'stop-uncertain' }; state.capabilities = allDenied;
  const fixture = await mockApi(page, state); await visitResult(page);
  await expect(book(page).getByRole('button', { name: 'Проверить остановку', exact: true })).toHaveCount(0);
  await book(page).getByRole('button', { name: 'Открыть этап и отчеты', exact: true }).click();
  await expect(book(page).getByRole('tab', { name: 'Этапы', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(stepDetails(page)).toHaveAttribute('data-node-id', 'implement');
  await expect(stepDetails(page).getByRole('button', { name: 'Восстановить', exact: true })).toHaveCount(0);
  expect(fixture.calls).toHaveLength(0);
});

for (const width of [1366, 390]) {
  test(`approval stays in the first viewport and keeps its gate contract at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    const state = snapshot(); state.workflow = 'autonomous'; state.phase = 'execution';
    state.task.title = state.task.goal = 'Добавить форму регистрации компании';
    const fixture = await mockApi(page, state); await page.goto(`/#session=${token}`);
    const quest = await openQuest(page);
    const approve = quest.getByRole('button', { name: 'Согласовать и начать выполнение', exact: true });
    await expect(approve).toBeEnabled(); const box = await approve.boundingBox();
    expect(box.y).toBeGreaterThan(0); expect(box.y + box.height).toBeLessThan(768);
    await approve.click(); const call = fixture.calls.find(call => call.action === 'gate');
    expect(call.body.challenge).toBe('challenge-fixture'); expect(call.body.permissions).toEqual(['workspace.source.write']);
    expect(call.body.planHash).toBe(state.planHash); expect(call.body.expectedRevision).toBe(3);
  });
}

test('lost snapshot does not keep reassuring running copy on screen', async ({ page }) => {
  await mockApi(page, running()); await visitResult(page);
  await expect(book(page).locator('.task-progress h3')).toContainText('Сейчас:');
  await page.route('**/api/runs/run-demo/snapshot', route => route.abort('connectionreset'));
  await book(page).getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(book(page).getByTestId('task-proof-status')).toBeVisible();
  await expect(book(page).getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Состояние недоступно');
  await expect(book(page).getByText('Flowcairn выполняет текущий этап', { exact: true })).toHaveCount(0);
  await expect(book(page).locator('.task-progress')).toHaveCount(0);
});

test('desktop book returns keyboard focus after closing and can reopen from world settings', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await mockApi(page, running()); await page.goto(`/#session=${token}`);
  const opener = page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Настройки', exact: true });
  await openDiagnostics(page, 'nodes');
  await book(page).getByRole('button', { name: 'Закрыть книгу диагностики', exact: true }).click();
  await expect(book(page)).toHaveCount(0); await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Служебные записи', exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Книга диагностики', exact: true }).press('Enter');
  await expect(book(page)).toBeVisible();
});

for (const width of [768, 1024]) {
  test(`tablet world keeps project name readable beside stopping controls at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 }); const state = running(); state.execution = { state: 'stopping' };
    await mockApi(page, state); await page.goto(`/#session=${token}`);
    const stopping = page.getByRole('complementary', { name: 'Текущее поручение' }).getByRole('button', { name: 'Останавливаем…', exact: true });
    await expect(stopping).toBeVisible(); await expect(stopping).toBeDisabled();
    await expect(page.locator('.game-brand p')).toHaveText('Тестовый проект');
    const geometry = await page.locator('.game-brand p').evaluate(element => {
      const name = element.getBoundingClientRect();
      const actions = document.querySelector('.quest-tracker').getBoundingClientRect();
      return { nameFits: element.scrollWidth <= element.clientWidth,
        overlap: name.left < actions.right && name.right > actions.left && name.top < actions.bottom && name.bottom > actions.top,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.nameFits).toBe(true); expect(geometry.overlap).toBe(false); expect(geometry.overflow).toBe(false);
  });
}
