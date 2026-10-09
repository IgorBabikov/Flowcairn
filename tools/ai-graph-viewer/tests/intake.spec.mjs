import { expect, test } from '@playwright/test';
import { book, openDiagnostics, openQuest, selectStep, showVersion, stepDetails, stepPicker, visitNewQuest, visitResult, newQuest } from './ui-paths.mjs';
import { mockApi, snapshot, projectContext, allowed, allDenied, graphNode, token } from './fixtures.mjs';

async function openSteps(page) {
  await openDiagnostics(page, 'nodes');
}

async function startTask(page) {
  await page.getByRole('button', { name: 'Начать анализ', exact: true }).click();
}

// Receipt of the POST is not UI acceptance. Hold its response to exercise the
// busy guard, then wait for the accepted task before navigating away.
async function acceptHeldIntake(page, release, description) {
  const intake = page.getByRole('dialog', { name: 'Новое поручение', exact: true });
  try {
    await expect(intake.getByLabel('Что нужно сделать', { exact: true })).toBeDisabled();
    await expect(intake.getByRole('button', { name: 'Закрыть свиток', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(intake).toBeVisible();
    await expect(intake.getByLabel('Что нужно сделать', { exact: true })).toHaveValue(description);
  } finally { release(); }
  const accepted = page.getByRole('dialog', { name: 'План и результат', exact: true });
  await expect(accepted.getByRole('heading', { name: 'Исправить поиск', exact: true })).toBeVisible();
  await expect(page.locator('#quest-intake')).toHaveCount(0);
}

test('pending intake shows progress and a timeout preserves the same request for retry', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyUntilIntake: true });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route('**/api/intake', async route => {
    requests.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ status: 504, json: { error: { code: 'SOURCE_CAPTURE_TIMEOUT', message: 'Подготовка задачи превысила допустимое время.' } } });
  });
  await visitNewQuest(page);
  await page.getByLabel('Название', { exact: true }).fill('Исправить поиск');
  await page.getByLabel('Что нужно сделать', { exact: true }).fill('Проверить пустой запрос');
  await page.getByLabel('Номер задачи', { exact: true }).fill('TASK-101');
  await startTask(page);
  await expect(page.locator('#quest-intake').getByRole('status').filter({ hasText: 'Подготавливаем снимок проекта и задачу' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Начинаем анализ…', exact: true })).toBeDisabled();
  release();
  await expect(page.locator('.error-banner')).toContainText('AI-анализ не запускался');
  await expect(page.locator('#quest-intake').getByRole('status').filter({ hasText: 'Подготавливаем снимок проекта и задачу' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить тот же запрос', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('unavailable planner stays fail-closed with a visible reason', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyUntilIntake: true, projectContext: {
    ...projectContext, capabilities: {intake: {allowed: false, reason: 'Подключите планировщик проекта'}},
  } });
  await page.goto(`/#session=${token}`);
  await openQuest(page);
  await page.getByLabel('Название', {exact:true}).fill('Исправить поиск');
  await page.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await page.getByLabel('Что нужно сделать', {exact:true}).fill('Добавить проверку');
  await expect(page.getByText('Подключите планировщик проекта')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Начать анализ', exact: true })).toBeDisabled();
});

test('compiles planning successor through backend without a client draft or automatic write', async ({ page }) => {
  const current = snapshot();
  current.phase = 'planning'; current.gates = []; current.status = 'passed';
  current.nodes = current.nodes.map(node => ({...node, status: 'passed', capabilities: allDenied}));
  current.capabilities = {...allDenied, requestReplan: {...allowed, label:'Показать план реализации'}};
  const fixture = await mockApi(page, current);
  await visitResult(page);
  await openDiagnostics(page, 'plan');
  await page.getByRole('button', {name: 'Показать план реализации'}).click();
  const version = await showVersion(page);
  await expect(version.getByTestId('plan-version')).toHaveText('2');
  const request = fixture.calls.find(call => call.action === 'replan').body;
  expect(Object.keys(request).sort()).toEqual(['expectedRevision', 'operationId', 'planHash']);
  expect(fixture.calls.filter(call => ['run','gate'].includes(call.action))).toHaveLength(0);
  await expect(page.locator('dialog[open]:not(.game-overlay)')).toHaveCount(0);
});

test('first-run composer remains readable on desktop, mobile, light and dark', async ({ page }, testInfo) => {
  await mockApi(page, snapshot(), {emptyUntilIntake: true});
  for (const [name, width, height, dark] of [
    ['desktop-light', 1440, 900, false], ['desktop-dark', 1440, 900, true],
    ['mobile-light', 390, 844, false], ['mobile-dark', 390, 844, true],
  ]) {
    await page.setViewportSize({width, height});
    await page.emulateMedia({reducedMotion:'reduce'});
    await visitNewQuest(page);
    await expect(page.getByLabel('Что нужно сделать', {exact:true})).toBeVisible();
    await page.evaluate(value => document.documentElement.toggleAttribute('data-dark', value), dark);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', {name:'Начать анализ', exact:true})).toBeVisible();
    await page.screenshot({path: testInfo.outputPath(`intake-${name}.png`), fullPage:true});
  }
});

test('world navigation remains available while initial data loads', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await mockApi(page, snapshot(), { emptyFirstList: true, projectDelayMs: 900, listDelayMs: 900 });
  await page.goto(`/#session=${token}`);
  const world = page.getByTestId('rpg-shell');
  await expect(world).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Игровое меню' })).toBeVisible();
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Загружаем проект…');
  await page.screenshot({ path: testInfo.outputPath('stable-loading-world.png') });
  await expect(page.getByTestId('rpg-runtime-status')).toHaveText('Поручений пока нет');
  await expect(world).toBeVisible();
  await newQuest(page);
  await expect(page.getByRole('heading', { name: 'Новое поручение', exact: true })).toBeVisible();
  await expect(page.locator('#quest-intake').locator('input,textarea,select')).toHaveCount(3);
  expect(fixture.calls).toEqual([]);
});

test('loading status remains readable and has no spinner motion under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, snapshot(), { emptyFirstList: true, projectDelayMs: 900, listDelayMs: 900 });
  await page.goto(`/#session=${token}`);
  const loader = page.getByTestId('rpg-runtime-status');
  await expect(loader).toBeVisible();
  await expect(loader).toHaveText('Загружаем проект…');
  await expect(loader).toHaveAttribute('role', 'status');
  expect(await loader.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

test('stale context requires a refresh and new request while preserving the task text', async ({page}) => {
  const options = { emptyUntilIntake: true, intakeError: {code:'STALE_CONTEXT', message:'Контекст изменился'} };
  let releaseIntake;
  options.intakeResponseGate = new Promise(resolve => { releaseIntake = resolve; });
  const fixture = await mockApi(page, snapshot(), options);
  await visitNewQuest(page);
  await page.getByLabel('Название', {exact:true}).fill('Исправить поиск');
  await page.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await page.getByLabel('Что нужно сделать', {exact:true}).fill('Исправить поиск');
  await startTask(page);
  await expect(page.getByRole('alert').filter({hasText:'Данные задачи устарели'}).last()).toBeVisible();
  await expect(page.getByRole('button', {name:'Повторить тот же запрос'})).toHaveCount(0);
  options.intakeError = null;
  options.projectContext = {...projectContext, contextHash:'b'.repeat(64)};
  await page.getByRole('button', {name:'Обновить контекст'}).click();
  await expect(page.getByLabel('Что нужно сделать', {exact:true})).toHaveValue('Исправить поиск');
  await startTask(page);
  await expect.poll(() => fixture.calls.filter(call => call.action === 'intake').length).toBe(2);
  await acceptHeldIntake(page, releaseIntake, 'Исправить поиск');
  await openSteps(page);
  await expect(stepPicker(page)).toBeVisible();
  await expect(stepDetails(page)).toBeVisible();
  const requests = fixture.calls.filter(call => call.action === 'intake').map(call => call.body);
  expect(requests).toHaveLength(2);
  expect(requests[1].contextHash).toBe('b'.repeat(64));
  expect(requests[1].operationId).not.toBe(requests[0].operationId);
});

test('failed registration refreshes changed bootstrap metadata without hiding the original error', async ({ page }) => {
  const options = { emptyUntilIntake: true, projectContext };
  let releaseIntake;
  options.intakeResponseGate = new Promise(resolve => { releaseIntake = resolve; });
  const fixture = await mockApi(page, snapshot(), options);
  let first = true;
  await page.route('**/api/intake', async route => {
    if (!first) return route.fallback();
    first = false;
    options.projectContext = { ...projectContext, contextHash: 'd'.repeat(64) };
    await route.fulfill({ status: 400, json: { error: { code: 'SKILLS_CONTEXT_TOO_LARGE', message: 'Контекст выбранных Skills слишком большой' } } });
  });
  await visitNewQuest(page);
  await page.getByLabel('Название', { exact: true }).fill('Исправить поиск');
  await page.getByLabel('Что нужно сделать', { exact: true }).fill('Проверить пустой запрос');
  await page.getByLabel('Номер задачи', { exact: true }).fill('TASK-101');
  await startTask(page);
  await expect(page.locator('.error-banner')).toContainText('выбранные правила не помещаются в безопасный контекст');
  await expect(page.getByLabel('Что нужно сделать', { exact: true })).toHaveValue('Проверить пустой запрос');
  await startTask(page);
  await expect.poll(() => fixture.calls.filter(call => call.action === 'intake').length).toBe(1);
  await acceptHeldIntake(page, releaseIntake, 'Проверить пустой запрос');
  await openSteps(page);
  await expect(stepPicker(page)).toBeVisible();
  await expect(stepDetails(page)).toBeVisible();
  expect(fixture.calls.find(call => call.action === 'intake').body.contextHash).toBe('d'.repeat(64));
});

test('unknown error keeps English diagnostics inside technical details', async ({ page }) => {
  await mockApi(page, snapshot(), {
    emptyUntilIntake: true,
    intakeError: {
      code: 'SOME_NEW_INTERNAL_FAILURE',
      message: 'unexpected response parser failed',
    },
  });
  await visitNewQuest(page);
  await page.getByLabel('Название', { exact: true }).fill('Проверить ошибку');
  await page.getByLabel('Что нужно сделать', { exact: true }).fill('Показать понятное сообщение');
  await page.getByLabel('Номер задачи', { exact: true }).fill('ERROR-1');
  await startTask(page);

  const error = page.locator('.error-banner');
  await expect(error).toContainText('Не удалось продолжить работу');
  const technical = error.locator('.technical-details');
  await expect(technical).not.toHaveAttribute('open', '');
  await expect(technical.getByText('unexpected response parser failed', { exact: true })).not.toBeVisible();
  await technical.locator('summary').click();
  await expect(technical).toContainText('SOME_NEW_INTERNAL_FAILURE');
  await expect(technical).toContainText('unexpected response parser failed');
});


test('approval shows only the skills and checks actually present in the backend plan', async ({page}) => {
  const current = snapshot();
  current.nodes.push(graphNode({id:'check-existing', title:'Проверить существующие тесты', action:{id:'check-tests', kind:'checks'}, skills:[], capabilities:allDenied}));
  await mockApi(page, current);
  await visitResult(page);
  await openSteps(page);
  await page.getByRole('button', {name:'Подтвердить план'}).click();
  const dialog = page.getByRole('dialog', {name:'Подтвердите решение'});
  await expect(dialog).toContainText('project-context · 111111111111');
  await expect(dialog).toContainText('Проверить существующие тесты (check-tests)');
  await expect(dialog).not.toContainText('80%');
  await expect(dialog).not.toContainText('100%');
  await expect(dialog.getByRole('button', {name:'Зафиксировать решение'})).toBeDisabled();
});


test('task form has exactly three fields even with a large or dirty project', async ({page}) => {
  const context = {...projectContext, scopeCandidates: Array.from({length:40}, (_, i) => `area-${i}`), bootstrap:{firstTask:true, required:true, changedPaths:['package.json'], untrackedCandidates:['src/new.ts'],snapshotHash:'c'.repeat(64)}};
  const fixture = await mockApi(page, snapshot(), {emptyUntilIntake:true, projectContext:context});
  await visitNewQuest(page);
  const form = page.locator('#quest-intake');
  await expect(form.locator('input, textarea, select')).toHaveCount(3);
  await expect(form.getByRole('checkbox')).toHaveCount(0);
  await form.getByLabel('Название').fill('Новая форма');
  await form.getByLabel('Что нужно сделать').fill('Сделать валидацию полей');
  await form.getByLabel('Номер задачи').fill('FORM-12');
  await startTask(page);
  await openSteps(page);
  await expect(stepPicker(page)).toBeVisible();
  await expect(stepDetails(page)).toBeVisible();
  const body = fixture.calls.find(call => call.action === 'intake').body;
  expect(Object.keys(body).sort()).toEqual(['contextHash','description','operationId','taskNumber','title']);
});

test('replan labels and visibility come from backend capabilities', async ({page}) => {
  const current = snapshot();
  current.phase = 'planning';
  current.nodes = current.nodes.map(node => ({...node, capabilities:allDenied}));
  current.capabilities = allDenied;
  const fixture = await mockApi(page, current);
  await visitResult(page);
  await openSteps(page);
  await selectStep(page, 'approve-plan');
  await expect(stepDetails(page)).toBeVisible();
  await expect(page.getByRole('button', {name:'Новая версия плана'})).toHaveCount(0);
  await expect(stepDetails(page).getByRole('button', { name: 'Повторить планирование', exact: true })).toHaveCount(0);
  await openDiagnostics(page, 'plan');
  await expect(book(page).getByRole('button', { name: 'Новая версия плана', exact: true })).toBeDisabled();
  fixture.current().capabilities = {...allDenied, requestReplan:{...allowed,label:'Повторить планирование'}};
  fixture.current().nodes[0].capabilities = {...allDenied, requestReplan:{...allowed,label:'Повторить планирование'}};
  fixture.current().revision += 1;
  await expect(book(page).getByRole('button', {name:'Повторить планирование', exact:true})).toBeEnabled();
  await openDiagnostics(page, 'nodes');
  await expect(stepDetails(page).getByRole('button', {name:'Повторить планирование'})).toBeVisible();
  await expect(page.getByRole('button', {name:'Показать план реализации'})).toHaveCount(0);
});


test('long task remains readable and expands with keyboard in the diagnostic book', async ({page}) => {
  const current = snapshot();
  const goal = 'Исправить поиск в списке задач: при пустом запросе показывать все результаты, при вводе учитывать название и описание, сохранить текущую сортировку и проверить существующие сценарии. '.repeat(3);
  current.task.goal = goal;
  current.task.title = 'Исправить поиск в списке задач';
  current.task.description = goal;
  await mockApi(page, current);
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height:900});
    await visitResult(page);
    await expect(book(page).locator('.diagnostic-heading p')).toHaveText(current.task.title);
    const summary = book(page).locator('.task-description > summary');
    await expect(summary).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.focus();
    await page.keyboard.press('Enter');
    const description = book(page).locator('.task-description .collapsible-text');
    await expect(description).toBeVisible();
    await description.getByRole('button', { name:'Показать полностью', exact:true }).click();
    expect((await description.locator('.readable-text p').allTextContents()).join(' ').replace(/\s+/g, ' ').trim()).toBe(goal.trim());
    const resultTab = book(page).getByRole('tab', { name: 'Результат', exact: true });
    await resultTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(book(page).getByRole('tab', { name: 'Этапы', exact: true })).toBeFocused();
    await expect(stepPicker(page)).toBeVisible();
    await book(page).getByRole('button', { name:'Текущий этап', exact:true }).click();
    await expect(stepDetails(page)).toHaveAttribute('data-node-id', 'approve-plan');
  }
});
