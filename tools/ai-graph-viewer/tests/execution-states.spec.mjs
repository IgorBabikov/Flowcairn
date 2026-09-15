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

test('native nodes follow backend transitions and only passed incoming dependencies animate', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await mockApi(page, executionSnapshot());
  await page.goto(`/#session=${token}`);
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
      expect(await node.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe(
        'execution-pulse',
      );
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
