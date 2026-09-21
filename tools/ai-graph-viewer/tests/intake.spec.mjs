import { expect, test } from '@playwright/test';
import { mockApi, snapshot, projectContext, allowed, allDenied, graphNode, token } from './fixtures.mjs';

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
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Заголовок задачи', { exact: true }).fill('Исправить поиск');
  await page.getByLabel('Полное описание задачи', { exact: true }).fill('Проверить пустой запрос');
  await page.getByLabel('Номер задачи', { exact: true }).fill('TASK-101');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.locator('.intake-progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запускаем…', exact: true })).toBeDisabled();
  release();
  await expect(page.locator('.dialog-error')).toContainText('AI-анализ не запускался');
  await expect(page.locator('.intake-progress')).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить тот же запрос', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('unavailable planner stays fail-closed with a visible reason', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyUntilIntake: true, projectContext: {
    ...projectContext, capabilities: {intake: {allowed: false, reason: 'Подключите планировщик проекта'}},
  } });
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Заголовок задачи', {exact:true}).fill('Исправить поиск');
  await page.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await page.getByLabel('Полное описание задачи', {exact:true}).fill('Добавить проверку');
  await expect(page.getByText('Подключите планировщик проекта')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запустить' })).toBeDisabled();
});

test('compiles planning successor through backend without a client draft or automatic write', async ({ page }) => {
  const current = snapshot();
  current.phase = 'planning'; current.gates = []; current.status = 'passed';
  current.nodes = current.nodes.map(node => ({...node, status: 'passed', capabilities: allDenied}));
  current.capabilities = {...allDenied, requestReplan: {...allowed, label:'Показать план реализации'}};
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', {name: 'Показать план реализации'}).click();
  await expect(page.getByTestId('plan-version')).toHaveText('2');
  const request = fixture.calls.find(call => call.action === 'replan').body;
  expect(Object.keys(request).sort()).toEqual(['expectedRevision', 'operationId', 'planHash']);
  expect(fixture.calls.filter(call => ['run','gate'].includes(call.action))).toHaveLength(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('first-run composer remains readable on desktop, mobile, light and dark', async ({ page }, testInfo) => {
  await mockApi(page, snapshot(), {emptyUntilIntake: true});
  for (const [name, width, height, dark] of [
    ['desktop-light', 1440, 900, false], ['desktop-dark', 1440, 900, true],
    ['mobile-light', 390, 844, false], ['mobile-dark', 390, 844, true],
  ]) {
    await page.setViewportSize({width, height});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(`/#session=${token}`);
    await expect(page.getByLabel('Полное описание задачи', {exact:true})).toBeVisible();
    await page.evaluate(value => document.documentElement.toggleAttribute('data-dark', value), dark);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', {name:'Запустить'})).toBeVisible();
    await page.screenshot({path: testInfo.outputPath(`intake-${name}.png`), fullPage:true});
  }
});


test('stale context requires a refresh and new request while preserving the task text', async ({page}) => {
  const options = { emptyUntilIntake: true, intakeError: {code:'STALE_CONTEXT', message:'Контекст изменился'} };
  const fixture = await mockApi(page, snapshot(), options);
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Заголовок задачи', {exact:true}).fill('Исправить поиск');
  await page.getByLabel('Номер задачи', {exact:true}).fill('TASK-101');
  await page.getByLabel('Полное описание задачи', {exact:true}).fill('Исправить поиск');
  await page.getByRole('button', {name:'Запустить'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Данные задачи устарели'}).last()).toBeVisible();
  await expect(page.getByRole('button', {name:'Повторить тот же запрос'})).toHaveCount(0);
  options.intakeError = null;
  options.projectContext = {...projectContext, contextHash:'b'.repeat(64)};
  await page.getByRole('button', {name:'Обновить контекст'}).click();
  await expect(page.getByLabel('Полное описание задачи', {exact:true})).toHaveValue('Исправить поиск');
  await page.getByRole('button', {name:'Запустить'}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const requests = fixture.calls.filter(call => call.action === 'intake').map(call => call.body);
  expect(requests).toHaveLength(2);
  expect(requests[1].contextHash).toBe('b'.repeat(64));
  expect(requests[1].operationId).not.toBe(requests[0].operationId);
});

test('failed registration refreshes changed bootstrap metadata without hiding the original error', async ({ page }) => {
  const options = { emptyUntilIntake: true, projectContext };
  const fixture = await mockApi(page, snapshot(), options);
  let first = true;
  await page.route('**/api/intake', async route => {
    if (!first) return route.fallback();
    first = false;
    options.projectContext = { ...projectContext, contextHash: 'd'.repeat(64) };
    await route.fulfill({ status: 400, json: { error: { code: 'SKILLS_CONTEXT_TOO_LARGE', message: 'Контекст выбранных Skills слишком большой' } } });
  });
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Заголовок задачи', { exact: true }).fill('Исправить поиск');
  await page.getByLabel('Полное описание задачи', { exact: true }).fill('Проверить пустой запрос');
  await page.getByLabel('Номер задачи', { exact: true }).fill('TASK-101');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.locator('.dialog-error')).toContainText('выбранные правила не помещаются в безопасный контекст');
  await expect(page.getByLabel('Полное описание задачи', { exact: true })).toHaveValue('Проверить пустой запрос');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  expect(fixture.calls.find(call => call.action === 'intake').body.contextHash).toBe('d'.repeat(64));
});


test('approval shows only the skills and checks actually present in the backend plan', async ({page}) => {
  const current = snapshot();
  current.nodes.push(graphNode({id:'check-existing', title:'Проверить существующие тесты', action:{id:'check-tests', kind:'checks'}, skills:[], capabilities:allDenied}));
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);
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
  await page.goto(`/#session=${token}`);
  const form = page.locator('.task-composer form');
  await expect(form.locator('input, textarea, select')).toHaveCount(3);
  await expect(form.getByRole('checkbox')).toHaveCount(0);
  await form.getByLabel('Заголовок задачи').fill('Новая форма');
  await form.getByLabel('Полное описание задачи').fill('Сделать валидацию полей');
  await form.getByLabel('Номер задачи').fill('FORM-12');
  await form.getByRole('button', {name:'Запустить'}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const body = fixture.calls.find(call => call.action === 'intake').body;
  expect(Object.keys(body).sort()).toEqual(['contextHash','description','operationId','taskNumber','title']);
});

test('replan labels and visibility come from backend capabilities', async ({page}) => {
  const current = snapshot();
  current.phase = 'planning';
  current.nodes = current.nodes.map(node => ({...node, capabilities:allDenied}));
  current.capabilities = allDenied;
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await expect(page.locator('.graph-node').first()).toBeVisible();
  await expect(page.getByRole('button', {name:'Новая версия плана'})).toHaveCount(0);
  await expect(page.locator('.next-action')).toHaveCount(0);
  fixture.current().capabilities = {...allDenied, requestReplan:{...allowed,label:'Повторить планирование'}};
  fixture.current().nodes[0].capabilities = {...allDenied, requestReplan:{...allowed,label:'Повторить планирование'}};
  fixture.current().revision += 1;
  await expect(page.locator('.next-action').getByRole('button', {name:'Повторить планирование'})).toBeVisible();
  await expect(page.locator('.detail-actions').getByRole('button', {name:'Повторить планирование'})).toBeVisible();
  await expect(page.getByRole('button', {name:'Показать план реализации'})).toHaveCount(0);
});


test('long task gets the full graph header width and expands with keyboard on desktop and mobile', async ({page}) => {
  const current = snapshot();
  const goal = 'Исправить поиск в списке задач: при пустом запросе показывать все результаты, при вводе учитывать название и описание, сохранить текущую сортировку и проверить существующие сценарии. '.repeat(3);
  current.task.goal = goal;
  await mockApi(page, current);
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height:900});
    await page.goto(`/#session=${token}`);
    const header = page.locator('.graph-header');
    const summary = page.locator('.graph-goal summary');
    await expect(summary).toBeVisible();
    const dimensions = await summary.evaluate(element => ({width:element.getBoundingClientRect().width, height:element.querySelector('span').getBoundingClientRect().height, lineHeight:parseFloat(getComputedStyle(element).lineHeight)}));
    const panel = await header.boundingBox();
    expect(dimensions.width).toBeGreaterThan(panel.width - 65);
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight * 2 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.graph-goal p')).toBeVisible();
    await expect(page.locator('.graph-goal p')).toHaveText(goal.trim());
    await expect(page.getByRole('button', {name:'Весь граф',exact:true})).toBeVisible();
  }
});
