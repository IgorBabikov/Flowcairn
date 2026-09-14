import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { graphNode, snapshot, mockApi, allDenied, token } from './fixtures.mjs';

function chain() {
  const current = snapshot();
  current.gates = [];
  current.status = 'running';
  current.activeNodeId = 'stage-4';
  current.task = { ...current.task, id: 'ORCH-001', goal: 'Добавить проверку пустого ввода', scope: ['src/validate.js'] };
  const actions = [
    ['human-approve', 'gate'], ['ai-analyze', 'analysis'], ['ai-implement', 'implementation'],
    ['workspace-check', 'checks'], ['check-lint', 'checks'], ['check-tests', 'checks'],
    ['ai-review', 'review'], ['artifact-handoff', 'handoff'], ['human-accept', 'gate'],
  ];
  const titles = [
    'Подтвердить план',
    'Понять задачу',
    'Реализовать',
    'Проверить изменения',
    'Проверить стиль кода',
    'Проверить тесты',
    'Провести независимое ревью',
    'Подготовить результат',
    'Принять результат',
  ];
  current.nodes = Array.from({ length: 9 }, (_, index) =>
    graphNode({
      id: `stage-${index}`,
      title: titles[index],
      action: { id: actions[index][0], kind: actions[index][1] },
      outcome: 'Выполнить условия этапа',
      receiptIds: [],
      skills: [],
      attempt: index <= 4 ? 1 : 0,
      needs: index ? [`stage-${index - 1}`] : [],
      status: index < 4 ? 'passed' : index === 4 ? 'running' : 'pending',
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
  fixture.current().nodes.find((node) => node.id === 'stage-4').status = 'passed';
  fixture.current().revision++;
  await expect(page.locator('[data-id="stage-4"] .node-status')).toHaveText('Завершен');
  expect(
    await page
      .locator('.react-flow__node')
      .evaluateAll((nodes) => nodes.map((node) => node.style.transform)),
  ).toEqual(transforms);
  fixture.current().nodes.find((node) => node.id === 'stage-4').status = 'running';
  fixture.current().revision++;
  await expect(page.locator('[data-id="stage-4"] .node-status')).toHaveText('Выполняется');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/compact-layout-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Сменить тему', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/compact-layout-dark.png', fullPage: true });
});

test('keeps a serial workflow compact when it retains transitive dependencies', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockApi(page, redundantChain());
  await page.goto(`/#session=${token}`);
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
