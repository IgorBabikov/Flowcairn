import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { graphNode, snapshot, mockApi, allDenied, runSummary, token } from './fixtures.mjs';
import { book, openDiagnostics, openJournal, closeSurface, stepPicker, stepDetails, selectStep, visitResult } from './ui-paths.mjs';

function chain() {
  const current = snapshot();
  current.gates = [];
  current.status = 'running';
  current.activeNodeId = 'stage-3';
  // FORM-102 — воспроизводимый presentation-сценарий первой задачи из docs/VERIFICATION.md.
  current.task = {
    ...current.task,
    id: 'FORM-102',
    taskNumber: 'FORM-102',
    goal: 'Добавить форму регистрации компании',
    scope: ['src/registration'],
    acceptance: [
      'Email и пароль валидируются',
      'Для компании показаны название и ИНН',
      'Повторная отправка заблокирована',
    ],
  };
  const actions = [
    ['ai-analyze', 'analysis'], ['ai-plan', 'planning'], ['human-approve', 'gate'],
    ['ai-implement', 'implementation'], ['workspace-check', 'checks'], ['check-tests', 'checks'],
    ['ai-review', 'review'], ['artifact-handoff', 'handoff'], ['human-accept', 'gate'],
  ];
  const titles = [
    'Анализ формы и проекта',
    'План реализации',
    'Согласовать план',
    'Реализовать форму регистрации',
    'Проверить изменения',
    'Проверить форму и тесты',
    'Провести независимое ревью',
    'Подготовить результат',
    'Готово к личному ревью',
  ];
  current.nodes = Array.from({ length: 9 }, (_, index) =>
    graphNode({
      id: `stage-${index}`,
      title: titles[index],
      action: { id: actions[index][0], kind: actions[index][1] },
      outcome: index === 3 ? 'Создать форму с email, паролем, названием компании и ИНН' : 'Выполнить условия этапа',
      receiptIds: [],
      skills: [],
      ...(index === 3
        ? {
            mode: 'write',
            permissions: ['workspace.source.write'],
            resources: { reads: ['src/registration'], writes: ['src/registration'] },
          }
        : {}),
      attempt: index <= 3 ? 1 : 0,
      needs: index ? [`stage-${index - 1}`] : [],
      status: index < 3 ? 'passed' : index === 3 ? 'running' : 'pending',
      capabilities: allDenied,
    }),
  );
  current.edges = current.nodes
    .slice(1)
    .map((node, index) => ({ id: `edge-${index}`, source: `stage-${index}`, target: node.id }));
  return current;
}
function redundantChain() {
  const current = snapshot();
  const ids = [
    'history-analyze',
    'approve-plan',
    'implement-1',
    'implement-2',
    'implement-3',
    'implement-4',
    'check-build',
    'check-types',
    'check-tests',
    'check-lint',
    'review',
    'handoff',
  ];
  current.nodes = ids.map((id, index) =>
    graphNode({
      id,
      title: id,
      needs: ids.slice(Math.max(0, index - 3), index),
      capabilities: allDenied,
      receiptIds: [],
      skills: [],
      status: index < 2 ? 'passed' : 'pending',
    }),
  );
  current.edges = current.nodes.flatMap((node) =>
    node.needs.map((source) => ({ id: `${source}--${node.id}`, source, target: node.id })),
  );
  current.activeNodeId = null;
  return current;
}

// G6: spatial graph layout is replaced by explicit step selection and readable dependencies.
async function expectPageFits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
}
async function expectContained(locator, page) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
}
async function dependencyText(page) {
  return stepDetails(page).locator('dt').filter({ hasText: /^Зависимости$/ }).locator('xpath=following-sibling::dd[1]').textContent();
}

test('desktop exposes the complete chain and preserves selected step on updates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const current = chain(); current.nodes.reverse();
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openDiagnostics(page, 'nodes');
  expect((await stepPicker(page).locator('option').evaluateAll(items => items.map(item => item.value).filter(Boolean))).sort()).toEqual(Array.from({ length: 9 }, (_, index) => `stage-${index}`));
  for (const index of [0, 3, 8]) {
    await selectStep(page, `stage-${index}`);
    await expect(stepDetails(page)).toHaveAttribute('data-node-id', `stage-${index}`);
    expect(await dependencyText(page)).toBe(index ? `stage-${index - 1}` : 'Нет');
  }
  await selectStep(page, 'stage-3');
  fixture.current().nodes.find(node => node.id === 'stage-3').status = 'passed'; fixture.current().revision++;
  await expect(stepDetails(page).locator('.status-chip')).toHaveText('Завершен');
  await expect(stepPicker(page)).toHaveValue('stage-3');
  fixture.current().nodes.find(node => node.id === 'stage-3').status = 'running'; fixture.current().revision++;
  await expect(stepDetails(page).locator('.status-chip')).toHaveText('Выполняется');
  await expectContained(stepPicker(page), page); await expectPageFits(page);
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/compact-layout-light.png', fullPage: true });
  await book(page).getByRole('button', { name: 'Сменить тему', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/compact-layout-dark.png', fullPage: true });
});

test('world running view leads with the task and opens diagnostics explicitly', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await mockApi(page, chain()); await page.goto(`/#session=${token}`);
  const tracker = page.getByRole('complementary', { name: 'Текущее поручение' });
  await expect(tracker).toContainText('Добавить форму регистрации компании');
  await expect(tracker.getByTestId('rpg-runtime-status')).toHaveText('Работа продолжается');
  await expect(book(page)).toHaveCount(0);
  await expect(tracker.getByRole('button', { name: 'Открыть поручение', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-first-running-1366x768.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('task-first-running-1440x900.png') });
  await openDiagnostics(page, 'result'); await expect(page.locator('.task-progress h3')).toContainText('Сейчас:');
  await closeSurface(page); await page.setViewportSize({ width: 390, height: 844 });
  await expect(tracker.getByTestId('rpg-runtime-status')).toHaveText('Работа продолжается');
  await expectPageFits(page); await page.screenshot({ path: testInfo.outputPath('task-first-running-390x844.png') });
});

test('journal actions remain readable and separate from the run list on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mockApi(page, chain()); await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  for (const name of ['Новое поручение', 'Обновить журнал', 'Открыть поручение']) {
    const button = journal.getByRole('button', { name, exact: true });
    await expect(button).toBeEnabled(); await expectContained(button, page);
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(40);
  }
  await expect(journal.locator('.journal-entry')).toHaveCount(1); await expectPageFits(page);
});

test('journal actions remain readable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mockApi(page, chain()); await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  for (const name of ['Закрыть журнал', 'Открыть поручение', 'Новое поручение', 'Обновить журнал']) {
    const button = journal.getByRole('button', { name, exact: true });
    await expectContained(button, page); expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(38);
  }
  await expectPageFits(page);
});

for (const mobile of [false, true]) {
  test(`diagnostic controls stay separate from selected step on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await mockApi(page, chain()); await page.goto(`/#session=${token}`); await selectStep(page, 'stage-8');
    await book(page).getByRole('button', { name: 'Текущий этап', exact: true }).click();
    await expect(stepPicker(page)).toHaveValue('stage-3');
    await expect(stepDetails(page).getByRole('heading', { name: 'Реализовать форму регистрации', exact: true })).toBeVisible();
    const geometry = await book(page).evaluate(element => {
      const tabs = element.querySelector('.diagnostic-chapters').getBoundingClientRect();
      const picker = element.querySelector('.diagnostic-node-picker').getBoundingClientRect();
      const details = element.querySelector('.diagnostic-node-details').getBoundingClientRect();
      return { tabsBottom: tabs.bottom, pickerTop: picker.top, pickerBottom: picker.bottom, detailsTop: details.top };
    });
    expect(geometry.tabsBottom).toBeLessThanOrEqual(geometry.pickerTop);
    expect(geometry.pickerBottom).toBeLessThanOrEqual(geometry.detailsTop);
    await expectContained(stepPicker(page), page); await expectPageFits(page);
  });
}

test('serial workflow preserves all transitive dependencies in diagnostics', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const current = redundantChain();
  await mockApi(page, current); await page.goto(`/#session=${token}`); await openDiagnostics(page, 'nodes');
  expect(await stepPicker(page).locator('option').evaluateAll(items => items.map(item => item.value).filter(Boolean))).toEqual(current.nodes.map(node => node.id));
  for (const node of current.nodes) {
    await selectStep(page, node.id);
    expect(await dependencyText(page)).toBe(node.needs.join(', ') || 'Нет');
  }
  await expectContained(stepDetails(page).getByRole('heading', { name: 'handoff', exact: true }), page);
});

test('fork and join keep both predecessors readable without truncating long titles', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const current = chain();
  current.nodes = [
    graphNode({ id: 'root', title: 'Подтвердить план', needs: [], capabilities: allDenied }),
    graphNode({ id: 'left', title: 'Проверить совместимость компонентов и обработку исключительных случаев при изменении интерфейса', needs: ['root'], capabilities: allDenied }),
    graphNode({ id: 'right', title: 'Проверить документацию', needs: ['root'], capabilities: allDenied }),
    graphNode({ id: 'join', title: 'Принять результат', needs: ['left', 'right'], capabilities: allDenied }),
  ];
  current.activeNodeId = null;
  current.edges = [{ id: 'a', source: 'root', target: 'left' }, { id: 'b', source: 'root', target: 'right' }, { id: 'c', source: 'left', target: 'join' }, { id: 'd', source: 'right', target: 'join' }];
  await mockApi(page, current); await page.goto(`/#session=${token}`); await selectStep(page, 'left');
  await expect(stepDetails(page).locator('h2')).toHaveText(current.nodes[1].title);
  await expectContained(stepDetails(page).locator('h2'), page);
  expect(await stepDetails(page).locator('h2').evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await dependencyText(page)).toBe('root');
  await selectStep(page, 'right'); expect(await dependencyText(page)).toBe('root');
  await selectStep(page, 'join'); expect(await dependencyText(page)).toBe('left, right');
  await mkdir('output/playwright', { recursive: true }); await page.screenshot({ path: 'output/playwright/compact-layout-fork.png', fullPage: true });
});

test('local scrolling keeps long task and journal bounded at laptop sizes', async ({ page }, testInfo) => {
  const current = redundantChain();
  current.task = { ...snapshot().task, title: 'Большая задача с длинным планом', description: 'Подробное описание пользовательской задачи и ожидаемого результата. '.repeat(32) };
  const extraRuns = Array.from({ length: 29 }, (_, index) => runSummary({ ...current, runId: `run-long-${index}`, task: { ...current.task, id: `TASK-${index}`, taskNumber: `TASK-${index}` } }));
  await mockApi(page, current, { extraRuns });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport); await visitResult(page);
    await page.getByText('Описание задачи', { exact: true }).click(); await page.getByRole('button', { name: 'Показать полностью', exact: true }).click();
    const paper = page.locator('.diagnostic-paper');
    expect(await paper.evaluate(el => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight)).toBe(true);
    await expectPageFits(page);
    const before = await page.evaluate(() => document.scrollingElement.scrollTop);
    await paper.hover(); await page.mouse.wheel(0, 600);
    await expect.poll(() => paper.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(before);
    if (viewport.width === 1366) await page.screenshot({ path: testInfo.outputPath('task-overview-1366x768.png') });
    const journal = await openJournal(page); await expect(journal.locator('.journal-entry')).toHaveCount(30);
    expect(await journal.locator('.journal-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expectContained(journal.locator('.journal-entry').last(), page); await expectPageFits(page);
  }
});

test('journal adapts at 1024 and 390 without page overflow', async ({ page }) => {
  await mockApi(page, chain()); await page.setViewportSize({ width: 1024, height: 768 }); await page.goto(`/#session=${token}`);
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); const journal = await openJournal(page);
    await expectContained(journal, page); await expectContained(journal.getByRole('button', { name: 'Открыть поручение', exact: true }), page);
    await expectPageFits(page); await closeSurface(page);
  }
});

test('loads local Latin and Cyrillic Manrope without an external font request', async ({ page }) => {
  await mockApi(page, chain()); await page.goto(`/#session=${token}`);
  const result = await page.evaluate(async () => {
    await document.fonts.load('400 16px Manrope', 'flowcairn Привет');
    return { ready: document.fonts.check('400 16px Manrope', 'flowcairn Привет'), family: getComputedStyle(document.body).fontFamily,
      fonts: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('Manrope-')) };
  });
  expect(result.ready).toBe(true); expect(result.family).toContain('Manrope');
  expect(result.fonts.some(name => name.includes('Manrope-Cyrillic-Variable.woff2'))).toBe(true);
  expect(result.fonts.some(name => name.includes('Manrope-Latin-Variable.woff2'))).toBe(true);
  expect(result.fonts.every(name => new URL(name).origin === new URL(page.url()).origin)).toBe(true);
});

test('primary controls keep accessible sizes and a visible keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); await mockApi(page, chain()); await page.goto(`/#session=${token}`);
  const journal = await openJournal(page);
  const create = journal.getByRole('button', { name: 'Новое поручение', exact: true });
  const primary = journal.getByRole('button', { name: 'Открыть поручение', exact: true });
  expect((await create.boundingBox()).height).toBeGreaterThanOrEqual(40);
  expect((await primary.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await primary.focus(); await page.keyboard.press('Tab'); await expect(create).toBeFocused();
  const focus = await create.evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor }; });
  expect(focus.style).toBe('solid'); expect(focus.width).toBeGreaterThanOrEqual(3); expect(focus.color).not.toBe('rgba(0, 0, 0, 0)');
  await closeSurface(page); const skip = page.locator('.skip-link'); await skip.focus();
  await expect(skip).toHaveAttribute('href', '#game-map-button'); await skip.press('Enter');
  await expect(page.locator('#game-map-button')).toBeFocused();
});
