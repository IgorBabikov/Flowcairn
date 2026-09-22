import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { graphNode, implementationNode, snapshot, mockApi, allDenied, token } from './fixtures.mjs';

const labels = {
  idle: 'Не начат',
  pending: 'В очереди',
  ready: 'Готов к запуску',
  running: 'Выполняется',
  passed: 'Завершен',
  failed: 'Ошибка',
  waiting: 'Ожидает решения',
  'waiting-for-human': 'Нужно решение',
  uncertain: 'Результат неизвестен',
  stale: 'Устарел',
};
function executionSnapshot(status = 'ready') {
  const current = snapshot();
  current.status = 'running';
  current.activeNodeId = 'implement';
  current.gates = [];
  current.nodes = [
    graphNode({
      id: 'approve-plan',
      title: 'Согласование плана',
      status: 'passed',
      capabilities: allDenied,
    }),
    {
      ...implementationNode,
      status,
      capabilities: allDenied,
      needs: ['approve-plan', 'verify-tests'],
    },
    graphNode({ id: 'verify-tests', title: 'tests', status: 'pending', capabilities: allDenied }),
  ];
  current.edges = [
    { id: 'approved-to-work', source: 'approve-plan', target: 'implement' },
    { id: 'pending-to-work', source: 'verify-tests', target: 'implement' },
  ];
  return current;
}
async function capture(page, name) {
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: `output/playwright/${name}.png`, fullPage: true });
}
async function openGraph(page) {
  await page.getByRole('button', { name: 'Граф · детали исполнения', exact: true }).click();
  const closeDetails = page.getByRole('button', { name: 'Закрыть детали', exact: true });
  if (await closeDetails.isVisible()) await closeDetails.click();
}

async function expectExecutionBorderContained(node) {
  const geometry = await node.evaluate((element) => {
    const card = element.getBoundingClientRect();
    const svg = element.querySelector('.execution-border');
    const track = svg?.querySelector('rect');
    if (!svg || !track) return null;
    const border = svg.getBoundingClientRect();
    const line = track.getBoundingClientRect();
    const svgStyle = getComputedStyle(svg);
    const trackStyle = getComputedStyle(track);
    return {
      card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom },
      border: { left: border.left, top: border.top, right: border.right, bottom: border.bottom },
      line: { left: line.left, top: line.top, right: line.right, bottom: line.bottom },
      overflow: svgStyle.overflow,
      filter: trackStyle.filter,
      vectorEffect: trackStyle.vectorEffect,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry.overflow).toBe('hidden');
  expect(geometry.filter).toBe('none');
  expect(geometry.vectorEffect).toBe('non-scaling-stroke');
  expect(geometry.border.left).toBeGreaterThanOrEqual(geometry.card.left);
  expect(geometry.border.top).toBeGreaterThanOrEqual(geometry.card.top);
  expect(geometry.border.right).toBeLessThanOrEqual(geometry.card.right);
  expect(geometry.border.bottom).toBeLessThanOrEqual(geometry.card.bottom);
  expect(geometry.border.left - geometry.card.left).toBeLessThanOrEqual(2.1);
  expect(geometry.border.top - geometry.card.top).toBeLessThanOrEqual(2.1);
  expect(geometry.card.right - geometry.border.right).toBeLessThanOrEqual(2.1);
  expect(geometry.card.bottom - geometry.border.bottom).toBeLessThanOrEqual(2.1);
  expect(geometry.line.left).toBeGreaterThanOrEqual(geometry.border.left);
  expect(geometry.line.top).toBeGreaterThanOrEqual(geometry.border.top);
  expect(geometry.line.right).toBeLessThanOrEqual(geometry.border.right);
  expect(geometry.line.bottom).toBeLessThanOrEqual(geometry.border.bottom);
}

test('native nodes follow backend transitions and only passed incoming dependencies animate', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await mockApi(page, executionSnapshot());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  const node = page.locator('.react-flow__node-operator[data-id="implement"] .graph-node');
  await expect(node).toContainText('Готов к запуску');
  await expect(page.locator('.dependency-active')).toHaveCount(0);
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.node-details h2')).toHaveText('Внесение изменений');
  expect(await node.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

  const paths = new Set();
  for (const [status, label] of Object.entries(labels)) {
    const next = fixture.current();
    next.revision += 1;
    next.nodes[1].status = status;
    next.nodes[1].reason = status === 'failed' ? 'Ожидается verify-tests: failed' : null;
    await expect(node).toHaveClass(new RegExp(`status-${status}(?: |$)`));
    await expect(node.locator('.node-status')).toHaveText(label);
    await expect(node).toHaveAttribute('aria-label', `Внесение изменений: ${label}`);
    paths.add(await node.locator('.status-icon path').getAttribute('d'));
    await expect(page.locator('.dependency-active')).toHaveCount(status === 'running' ? 1 : 0);
    if (status === 'running') {
      await expect(page.locator('.react-flow__edge[data-id="pending-to-work"]')).not.toHaveClass(
        /animated/,
      );
      const snake = node.locator('.execution-border rect');
      expect(await snake.evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'execution-snake',
      );
      await expectExecutionBorderContained(node);
      const initialSnakePosition = await snake.evaluate((el) => getComputedStyle(el).strokeDashoffset);
      await expect
        .poll(
          () => snake.evaluate((el) => getComputedStyle(el).strokeDashoffset),
          { timeout: 500 },
        )
        .not.toBe(initialSnakePosition);
      await page.getByRole('button', { name: 'Весь граф', exact: true }).click();
      await capture(page, 'execution-desktop-light-running');
      await page.getByRole('button', { name: 'Сменить тему' }).click();
      const darkContrast = await page.locator('.graph-node').evaluateAll((nodes) => {
        const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const luminance = (value) => rgb(value)
          .map(channel => channel / 255)
          .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const ratio = (foreground, background) => {
          const front = luminance(foreground), back = luminance(background);
          return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
        };
        return nodes.flatMap(node => {
          const background = getComputedStyle(node).backgroundColor;
          return [node.querySelector('strong'), node.querySelector('.node-status'), node.querySelector('.node-hint')]
            .filter(Boolean)
            .map(text => ratio(getComputedStyle(text).color, background));
        });
      });
      expect(Math.min(...darkContrast)).toBeGreaterThanOrEqual(4.5);
      await capture(page, 'execution-desktop-dark-running');
      await page.getByRole('button', { name: 'Сменить тему' }).click();
    }
    if (status === 'failed')
      await expect(page.locator('.runtime-reason')).toContainText(
        'Ожидается этап verify-tests: ошибка',
      );
    if (status !== 'running')
      expect(await node.evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe(
        'none',
      );
  }
  expect(paths.size).toBe(9); // waiting is an alias for waiting-for-human.
  expect(errors).toEqual([]);
});

test('ready active ID remains static across polling and predecessor changes revoke animation', async ({
  page,
}) => {
  const fixture = await mockApi(page, executionSnapshot());
  await page.goto(`/#session=${token}`);
  await openGraph(page);
  const node = page.locator('[data-id="implement"] .graph-node');
  await expect(node).toContainText('Готов к запуску');
  const reads = fixture.snapshotReads();
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.locator('.dependency-active')).toHaveCount(0);
  await expect(node).toHaveClass(/status-ready/);
  fixture.current().nodes[1].status = 'running';
  fixture.current().revision += 1;
  await expect(page.locator('.dependency-active')).toHaveCount(1);
  fixture.current().nodes[0].status = 'uncertain';
  fixture.current().revision += 1;
  await expect(page.locator('.dependency-active')).toHaveCount(0);
});

for (const dark of [false, true]) {
  test(`mobile ${dark ? 'dark' : 'light'} reduced-motion preserves visible execution state`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockApi(page, executionSnapshot('running'));
    await page.goto(`/#session=${token}`);
    await openGraph(page);
    if (dark) await page.getByRole('button', { name: 'Сменить тему' }).click();
    const node = page.locator('[data-id="implement"] .graph-node');
    await expect(node).toContainText('Выполняется');
    await expect(page.locator('.dependency-active')).toHaveCount(1);
    const motion = await node.evaluate((el) => ({
      glow: getComputedStyle(el.querySelector('.execution-border rect')).animationName,
      border: getComputedStyle(el).borderTopStyle,
      color: getComputedStyle(el).borderTopColor,
    }));
    expect(motion.glow).toBe('none');
    expect(motion.border).toBe('solid');
    expect(motion.color).not.toBe('rgba(0, 0, 0, 0)');
    await expectExecutionBorderContained(node);
    expect(
      await page
        .locator('.dependency-active path.react-flow__edge-path')
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await capture(page, `execution-mobile-${dark ? 'dark' : 'light'}-reduced-motion`);
  });
}
