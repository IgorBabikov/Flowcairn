import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { graphNode, snapshot, mockApi, allDenied, runSummary, token } from './fixtures.mjs';

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
async function positions(page) {
  return page.locator('.react-flow__node').evaluateAll((nodes) =>
    nodes.map((node) => {
      const card = node.querySelector('.graph-node').getBoundingClientRect();
      return {
        id: node.getAttribute('data-id'),
        x: card.x,
        y: card.y,
        w: card.width,
        h: card.height,
      };
    }),
  );
}

function overlaps(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

async function openGraph(page) {
  await page.getByRole('button', { name: 'Граф · детали исполнения', exact: true }).click();
  const closeDetails = page.getByRole('button', { name: 'Закрыть детали', exact: true });
  if (await closeDetails.isVisible()) await closeDetails.click();
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

test('desktop opens the complete dependency-ordered chain in compact rows and preserves positions on updates', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const current = chain();
  current.nodes.reverse(); // Array order must not replace dependency order.
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.graph-node')).toHaveCount(9);
  const cards = await positions(page);
  expect(cards.map((card) => card.id)).toEqual(
    Array.from({ length: 9 }, (_, index) => `stage-${index}`),
  );
  const find = (id) => cards.find((card) => card.id === `stage-${id}`);
  expect(find(0).x).toBeLessThan(find(1).x);
  expect(find(1).x).toBeLessThan(find(2).x);
  expect(find(2).y).toBeCloseTo(find(0).y, 0);
  expect(find(3).y).toBeGreaterThan(find(2).y + find(2).h);
  expect(find(3).x).toBeCloseTo(find(2).x, 0);
  expect(find(4).x).toBeLessThan(find(3).x);
  expect(find(6).y).toBeGreaterThan(find(5).y + find(5).h);
  const canvas = await page.locator('.react-flow').boundingBox();
  for (const card of cards) {
    expect(card.w).toBeGreaterThan(175);
    expect(card.x).toBeGreaterThanOrEqual(canvas.x);
    expect(card.y).toBeGreaterThanOrEqual(canvas.y);
    expect(card.x + card.w).toBeLessThanOrEqual(canvas.x + canvas.width);
    expect(card.y + card.h).toBeLessThanOrEqual(canvas.y + canvas.height);
  }
  await expect(page.locator('[data-id="stage-2"] .react-flow__handle-bottom.source')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-id="stage-3"] .react-flow__handle-top.target')).toHaveCount(1);
  const transforms = await page
    .locator('.react-flow__node')
    .evaluateAll((nodes) => nodes.map((node) => node.style.transform));
  fixture.current().nodes.find((node) => node.id === 'stage-3').status = 'passed';
  fixture.current().revision++;
  await expect(page.locator('[data-id="stage-3"] .node-status')).toHaveText('Завершен');
  expect(
    await page
      .locator('.react-flow__node')
      .evaluateAll((nodes) => nodes.map((node) => node.style.transform)),
  ).toEqual(transforms);
  fixture.current().nodes.find((node) => node.id === 'stage-3').status = 'running';
  fixture.current().revision++;
  await expect(page.locator('[data-id="stage-3"] .node-status')).toHaveText('Выполняется');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/compact-layout-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Сменить тему', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/compact-layout-dark.png', fullPage: true });
});

test('task-first running view leads with the task and keeps the graph behind an explicit action', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const current = chain();
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);

  await expect(page.getByRole('heading', { name: 'Добавить форму регистрации компании' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Что происходит сейчас' })).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Граф · детали исполнения', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-first-running-1366x768.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('task-first-running-1440x900.png') });

  await openGraph(page);
  await expect(page.locator('.react-flow')).toBeVisible();

  await page.getByRole('button', { name: 'Задача', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Что происходит сейчас' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-first-running-390x844.png') });
});

test('keeps run rail actions on one compact line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  const heading = await page.locator('.rail-heading').boundingBox();
  const newTask = await page.locator('#new-task').boundingBox();
  const refresh = await page.getByRole('button', { name: 'Обновить', exact: true }).boundingBox();
  expect(heading).not.toBeNull();
  expect(newTask).not.toBeNull();
  expect(refresh).not.toBeNull();
  expect(newTask.height).toBeGreaterThanOrEqual(40);
  expect(refresh.height).toBeGreaterThanOrEqual(40);
  expect(newTask.y).toBeGreaterThanOrEqual(heading.y);
  expect(newTask.y + newTask.height).toBeLessThanOrEqual(heading.y + heading.height);
});

test('keeps run rail actions readable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Показать запуски', exact: true }).click();
  const rail = page.getByRole('dialog', { name: 'Запуски', exact: true });
  const heading = await rail.locator('header').boundingBox();
  const close = await rail.getByRole('button', { name: 'Закрыть', exact: true }).boundingBox();
  expect(heading).not.toBeNull();
  expect(close).not.toBeNull();
  expect(close.height).toBeGreaterThanOrEqual(38);
  expect(close.x + close.width).toBeLessThanOrEqual(heading.x + heading.width);
});

test('keeps canvas controls in a reserved top-left zone away from graph nodes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  const controls = page.locator('.react-flow__controls');
  await expect(controls).toHaveClass(/top/);
  await expect(controls).toHaveClass(/left/);
  const controlsBox = await controls.boundingBox();
  const cards = await page.locator('.graph-node').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  expect(controlsBox).not.toBeNull();
  for (const card of cards) expect(overlaps(controlsBox, card)).toBe(false);
});

test('keeps controls away from the focused node on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  const controls = page.locator('.react-flow__controls');
  await expect(controls).toHaveClass(/top/);
  const controlsBox = await controls.boundingBox();
  const visibleCards = await page.locator('.graph-node').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })
      .filter((box) => box.x + box.width > 0 && box.y + box.height > 0),
  );
  expect(controlsBox).not.toBeNull();
  for (const card of visibleCards) expect(overlaps(controlsBox, card)).toBe(false);
});

test('keeps a serial workflow compact when it retains transitive dependencies', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockApi(page, redundantChain());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.graph-node')).toHaveCount(12);

  const cards = await positions(page);
  const byId = (id) => cards.find((card) => card.id === id);
  expect(byId('history-analyze').x).toBeLessThan(byId('approve-plan').x);
  expect(byId('approve-plan').x).toBeLessThan(byId('implement-1').x);
  expect(byId('implement-2').y).toBeGreaterThan(byId('implement-1').y + byId('implement-1').h);
  expect(byId('implement-2').x).toBeCloseTo(byId('implement-1').x, 0);
  expect(byId('implement-3').x).toBeLessThan(byId('implement-2').x);
  expect(byId('implement-4').x).toBeLessThan(byId('implement-3').x);
  expect(byId('check-build').y).toBeGreaterThan(byId('implement-4').y + byId('implement-4').h);
  await expect(page.locator('[data-id="history-analyze"] .react-flow__handle-right.source')).toHaveCount(1);
  await expect(page.locator('[data-id="approve-plan"] .react-flow__handle-left.target')).toHaveCount(1);
});

test('fork and join remain hierarchical and long titles do not overlap cards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const current = chain();
  current.nodes = [
    graphNode({ id: 'root', title: 'Подтвердить план', needs: [], capabilities: allDenied }),
    graphNode({
      id: 'left',
      title:
        'Проверить совместимость компонентов и обработку исключительных случаев при изменении интерфейса',
      needs: ['root'],
      capabilities: allDenied,
    }),
    graphNode({
      id: 'right',
      title: 'Проверить документацию',
      needs: ['root'],
      capabilities: allDenied,
    }),
    graphNode({
      id: 'join',
      title: 'Принять результат',
      needs: ['left', 'right'],
      capabilities: allDenied,
    }),
  ];
  current.activeNodeId = null;
  current.edges = [
    { id: 'a', source: 'root', target: 'left' },
    { id: 'b', source: 'root', target: 'right' },
    { id: 'c', source: 'left', target: 'join' },
    { id: 'd', source: 'right', target: 'join' },
  ];
  await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  await expect(page.locator('.graph-node')).toHaveCount(4);
  const cards = await positions(page),
    byId = (id) => cards.find((card) => card.id === id);
  expect(byId('root').y + byId('root').h).toBeLessThan(byId('left').y);
  expect(byId('left').x + byId('left').w).toBeLessThan(byId('right').x);
  expect(byId('left').y).toBeCloseTo(byId('right').y, 0);
  expect(byId('left').y + byId('left').h).toBeLessThan(byId('join').y);
  await expect(page.locator('[data-id="left"] .react-flow__handle-top.target')).toHaveCount(1);
  await page.locator('[data-id="left"] .graph-node').click();
  await expect(page.locator('.node-details h2')).toHaveText(current.nodes[1].title);
  await page.screenshot({ path: 'output/playwright/compact-layout-fork.png', fullPage: true });
});

test('single scroll keeps long task and run list bounded at laptop sizes', async ({ page }, testInfo) => {
  const current = redundantChain();
  current.task = {
    ...snapshot().task,
    title: 'Большая задача с длинным планом',
    description: 'Подробное описание пользовательской задачи и ожидаемого результата. '.repeat(32),
  };
  const extraRuns = Array.from({ length: 29 }, (_, index) => runSummary({
    ...current,
    runId: `run-long-${index}`,
    task: { ...current.task, id: `TASK-${index}`, taskNumber: `TASK-${index}` },
  }));
  await mockApi(page, current, { extraRuns });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/#session=${token}`);
    await expect(page.locator('.task-overview')).toBeVisible();
    const metrics = await page.evaluate(() => {
      const main = document.querySelector('.main-content');
      const rail = document.querySelector('.desktop-run-rail .run-list');
      return {
        documentFits: document.documentElement.scrollHeight <= window.innerHeight,
        bodyFits: document.body.scrollHeight <= window.innerHeight,
        mainOverflowY: main ? getComputedStyle(main).overflowY : '',
        mainScrollable: Boolean(main && main.scrollHeight > main.clientHeight),
        railScrollable: Boolean(rail && rail.scrollHeight > rail.clientHeight),
        detailCount: document.querySelectorAll('.detail-scroll').length,
      };
    });
    expect(metrics.documentFits).toBe(true);
    expect(metrics.bodyFits).toBe(true);
    expect(metrics.mainOverflowY).toBe('auto');
    expect(metrics.mainScrollable).toBe(true);
    expect(metrics.railScrollable).toBe(true);
    expect(metrics.detailCount).toBe(0);
    if (viewport.width === 1366)
      await page.screenshot({ path: testInfo.outputPath('task-overview-1366x768.png') });
    const before = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
    await page.locator('.main-content').hover();
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(before);
  }
});

test('1024 rail and 390 drawer use responsive widths without page overflow', async ({ page }) => {
  await mockApi(page, chain());
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/#session=${token}`);
  expect((await page.locator('.desktop-run-rail').boundingBox())?.width).toBeCloseTo(220, 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.desktop-run-rail')).toBeHidden();
  await page.getByRole('button', { name: 'Показать запуски', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Запуски', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('loads local Latin and Cyrillic Manrope without an external font request', async ({ page }) => {
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  const result = await page.evaluate(async () => {
    await document.fonts.load('400 16px Manrope', 'flowcairn Привет');
    return {
      ready: document.fonts.check('400 16px Manrope', 'flowcairn Привет'),
      family: getComputedStyle(document.body).fontFamily,
      fonts: performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('Manrope-')),
    };
  });
  expect(result.ready).toBe(true);
  expect(result.family).toContain('Manrope');
  expect(result.fonts.some((name) => name.includes('Manrope-Cyrillic-Variable.woff2'))).toBe(true);
  expect(result.fonts.some((name) => name.includes('Manrope-Latin-Variable.woff2'))).toBe(true);
  const viewerOrigin = new URL(page.url()).origin;
  expect(result.fonts.every((name) => new URL(name).origin === viewerOrigin)).toBe(true);
});

test('primary controls keep accessible sizes and a visible keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await mockApi(page, chain());
  await page.goto(`/#session=${token}`);
  const controls = await page.locator('.button:visible, .task-view-switch button:visible').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { width: box.width, height: box.height, primary: button.classList.contains('primary') };
    }));
  expect(Math.min(...controls.map((control) => control.height))).toBeGreaterThanOrEqual(40);
  expect(Math.min(...controls.filter((control) => control.primary).map((control) => control.height))).toBeGreaterThanOrEqual(44);
  const create = page.locator('#new-task');
  await create.focus();
  const focus = await create.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
  });
  expect(focus.style).toBe('solid');
  expect(focus.width).toBeGreaterThanOrEqual(3);
  expect(focus.color).not.toBe('rgba(0, 0, 0, 0)');
  const skip = page.locator('.skip-link');
  await expect(skip).toHaveAttribute('href', '#main-content');
  await expect(page.locator('#main-content')).toHaveCount(1);
});
