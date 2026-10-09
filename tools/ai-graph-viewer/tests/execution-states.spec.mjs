import { test, expect } from '@playwright/test';
import { book, openDiagnostics, stepPicker, stepDetails, selectStep } from './ui-paths.mjs';
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
// G6 exposes backend states in the selected step and picker; graph animation no longer conveys truth.
async function expectState(page, status) {
  await expect(stepDetails(page).locator('.status-chip')).toHaveText(labels[status]);
  await expect(stepDetails(page).locator('.status-chip')).toHaveClass(new RegExp(`status-${status}(?: |$)`));
  await expect(stepPicker(page).locator('option:checked')).toContainText(labels[status]);
  await expect(stepPicker(page)).toHaveValue('implement');
}
async function contrast(page) {
  return stepDetails(page).evaluate(element => {
    const rgb = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = value => rgb(value).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return [...element.querySelectorAll('h2, .status-chip, dt, dd')].map(text => {
      let surface = text;
      while (surface.parentElement && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
      const front = luminance(getComputedStyle(text).color), back = luminance(getComputedStyle(surface).backgroundColor);
      return (Math.max(front, back) + .05) / (Math.min(front, back) + .05);
    });
  });
}

test('diagnostic states follow every backend transition and preserve dependency facts', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await mockApi(page, executionSnapshot()); await page.goto(`/#session=${token}`); await selectStep(page, 'implement');
  await expectState(page, 'ready'); await stepPicker(page).focus(); await expect(stepPicker(page)).toBeFocused();
  const stateClasses = new Set();
  for (const [status] of Object.entries(labels)) {
    const next = fixture.current(); next.revision++; next.nodes[1].status = status;
    next.nodes[1].reason = status === 'failed' ? 'Ожидается verify-tests: failed' : null;
    await expectState(page, status); stateClasses.add(await stepDetails(page).locator('.status-chip').getAttribute('class'));
    await expect(stepDetails(page).locator('.fact-list')).toContainText('approve-plan, verify-tests');
    if (status === 'running') {
      await expect(stepPicker(page).locator('option[value="approve-plan"]')).toContainText('Завершен');
      await expect(stepPicker(page).locator('option[value="verify-tests"]')).toContainText('В очереди');
      await capture(page, 'execution-desktop-light-running');
      await book(page).getByRole('button', { name: 'Сменить тему', exact: true }).click();
      expect(Math.min(...await contrast(page))).toBeGreaterThanOrEqual(4.5);
      await capture(page, 'execution-desktop-dark-running');
      await book(page).getByRole('button', { name: 'Сменить тему', exact: true }).click();
    }
    if (status === 'failed') await expect(stepDetails(page).locator('.runtime-reason')).toContainText('Ожидается этап verify-tests: ошибка');
    else await expect(stepDetails(page).locator('.runtime-reason')).toHaveCount(0);
    if (status !== 'running') {
      await expect(stepDetails(page).locator('.status-chip')).not.toHaveClass(/status-running/);
      expect(await stepDetails(page).locator('.status-chip').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    }
  }
  expect(stateClasses.size).toBe(Object.keys(labels).length); expect(errors).toEqual([]);
});

test('ready active ID stays ready across polling and uncertain predecessor remains explicit', async ({ page }) => {
  const fixture = await mockApi(page, executionSnapshot()); await page.goto(`/#session=${token}`); await selectStep(page, 'implement');
  await expectState(page, 'ready'); const reads = fixture.snapshotReads();
  await expect.poll(() => fixture.snapshotReads()).toBeGreaterThan(reads); await expectState(page, 'ready');
  fixture.current().nodes[1].status = 'running'; fixture.current().revision++; await expectState(page, 'running');
  fixture.current().nodes[0].status = 'uncertain'; fixture.current().revision++;
  await expect(stepPicker(page).locator('option[value="approve-plan"]')).toContainText('Результат неизвестен');
  await expectState(page, 'running');
  await selectStep(page, 'approve-plan'); await expect(stepDetails(page).locator('.status-chip')).toHaveText('Результат неизвестен');
  await expect(stepDetails(page).getByRole('button', { name: 'Запустить', exact: true })).toHaveCount(0);
});

for (const dark of [false, true]) {
  test(`mobile ${dark ? 'dark' : 'light'} reduced-motion preserves visible execution state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockApi(page, executionSnapshot('running')); await page.goto(`/#session=${token}`); await openDiagnostics(page, 'nodes');
    if (dark) await book(page).getByRole('button', { name: 'Сменить тему', exact: true }).click();
    await selectStep(page, 'implement'); await expectState(page, 'running');
    await expect(stepDetails(page).locator('.fact-list')).toContainText('approve-plan, verify-tests');
    const chip = stepDetails(page).locator('.status-chip'); await chip.scrollIntoViewIfNeeded();
    expect(await chip.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await expect(chip).toBeInViewport();
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `execution-mobile-${dark ? 'dark' : 'light'}-reduced-motion`);
  });
}
