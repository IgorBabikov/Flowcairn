import { expect, test } from '@playwright/test';
import { mockApi, snapshot, projectContext, allowed, allDenied, graphNode, token } from './fixtures.mjs';

test('unavailable planner stays fail-closed with a visible reason', async ({ page }) => {
  await mockApi(page, snapshot(), { emptyUntilIntake: true, projectContext: {
    ...projectContext, capabilities: {intake: {allowed: false, reason: 'Подключите планировщик проекта'}},
  } });
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Задача', {exact:true}).fill('Добавить проверку');
  await expect(page.getByText('Подключите планировщик проекта')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Составить план' })).toBeDisabled();
});

test('compiles planning successor through backend without a client draft or automatic write', async ({ page }) => {
  const current = snapshot();
  current.phase = 'planning'; current.gates = []; current.status = 'passed';
  current.nodes = current.nodes.map(node => ({...node, status: 'passed', capabilities: allDenied}));
  current.capabilities = {...allDenied, requestReplan: allowed};
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
    await expect(page.getByLabel('Задача', {exact:true})).toBeVisible();
    await page.evaluate(value => document.documentElement.toggleAttribute('data-dark', value), dark);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', {name:'Составить план'})).toBeVisible();
    await page.screenshot({path: testInfo.outputPath(`intake-${name}.png`), fullPage:true});
  }
});


test('stale context requires a refresh and new request while preserving the task text', async ({page}) => {
  const options = { emptyUntilIntake: true, intakeError: {code:'STALE_CONTEXT', message:'Контекст изменился'} };
  const fixture = await mockApi(page, snapshot(), options);
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Задача', {exact:true}).fill('Исправить поиск');
  await page.getByRole('button', {name:'Составить план'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Контекст изменился'}).last()).toBeVisible();
  await expect(page.getByRole('button', {name:'Повторить тот же запрос'})).toHaveCount(0);
  options.intakeError = null;
  options.projectContext = {...projectContext, contextHash:'b'.repeat(64)};
  await page.getByRole('button', {name:'Обновить контекст'}).click();
  await expect(page.getByLabel('Задача', {exact:true})).toHaveValue('Исправить поиск');
  await page.getByRole('button', {name:'Составить план'}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const requests = fixture.calls.filter(call => call.action === 'intake').map(call => call.body);
  expect(requests).toHaveLength(2);
  expect(requests[1].contextHash).toBe('b'.repeat(64));
  expect(requests[1].operationId).not.toBe(requests[0].operationId);
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


test('large projects can narrow backend candidates without broadening write permissions', async ({page}) => {
  const context = {...projectContext, scopeCandidates: Array.from({length:40}, (_, i) => `area-${i}`)};
  const fixture = await mockApi(page, snapshot(), {emptyUntilIntake:true, projectContext:context});
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Задача', {exact:true}).fill('Исправить выбранную часть');
  await expect(page.getByRole('button', {name:'Составить план'})).toBeDisabled();
  await page.getByText('Области задачи · 0 из 40').click();
  await page.getByRole('checkbox', {name:'area-2', exact:true}).check();
  await page.getByRole('button', {name:'Составить план'}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const body = fixture.calls.find(call => call.action === 'intake').body;
  expect(body.scope).toEqual(['area-2']);
  expect(body.permissions).toBeUndefined();
});


test('dirty first install requires exact snapshot consent and explicit new-file selection', async ({page}) => {
  const context = {...projectContext, bootstrap: {firstTask:true, required:true, changedPaths:['package.json', 'AGENTS.md'], untrackedCandidates:['src/new.ts'], requiredUntracked:[{path:'.flowcairn.json', hash:'d'.repeat(64)}], snapshotHash:'c'.repeat(64)}};
  const fixture = await mockApi(page, snapshot(), {emptyUntilIntake:true, projectContext:context});
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Задача', {exact:true}).fill('Исправить поиск');
  await expect(page.getByRole('button', {name:'Составить план'})).toBeDisabled();
  await expect(page.getByText('Чтобы составить план, подтвердите исходный снимок изменений ниже.')).toBeVisible();
  await expect(page.getByRole('checkbox', {name:'Включить перечисленные изменения в исходный снимок'})).toBeVisible();
  await expect(page.getByRole('region', {name:'Исходный снимок'})).toContainText('package.json');
  const mandatory = page.getByRole('list', {name:'Обязательные файлы'});
  await expect(mandatory).toBeVisible();
  await expect(mandatory).toContainText('.flowcairn.json');
  await expect(mandatory).toContainText('dddddddddddd');
  await expect(page.getByRole('checkbox', {name:'.flowcairn.json', exact:true})).toHaveCount(0);
  const file = page.getByRole('checkbox', {name:'src/new.ts', exact:true});
  await expect(file).not.toBeChecked();
  const consent = page.getByRole('checkbox', {name:'Включить перечисленные изменения в исходный снимок'});
  await consent.check();
  await file.check();
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.getByRole('button', {name:'Составить план'}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const body = fixture.calls.find(call => call.action === 'intake').body;
  expect(body.snapshot).toBe(true);
  expect(body.snapshotHash).toBe(context.bootstrap.snapshotHash);
  expect(body.includeUntracked).toEqual(['src/new.ts']);
  expect(body.permissions).toBeUndefined();
});
