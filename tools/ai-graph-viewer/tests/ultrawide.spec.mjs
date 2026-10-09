import { test, expect } from '@playwright/test';
import { mockApi, token, objectHash } from './fixtures.mjs';
import { widePlanFixture, wideProofFixture } from './wide-fixtures.mjs';
import { book, openDiagnostics, closeSurface, newQuest, selectStep, stepDetails } from './ui-paths.mjs';

async function mount(page, fixture, extra = {}) {
  const api = await mockApi(page, fixture.state, { planResponses: { [fixture.state.runId]: { plan: fixture.plan } }, ...extra });
  await page.goto(`/#session=${token}`);
  if (!extra.emptyUntilIntake) await openDiagnostics(page, 'result');
  return api;
}
async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  const surface = page.locator('.game-overlay[open]');
  const rect = await surface.boundingBox();
  expect(rect).not.toBeNull(); expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
}
for (const width of [1920, 2560, 3440, 3840]) {
  test(`diagnostic book keeps plan and linked requirements readable at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 }); const fixture = widePlanFixture(); await mount(page, fixture);
    await expect(page.locator('.workflow-steps > li')).toHaveCount(4);
    await fits(page);
    await expect(book(page).getByRole('button', { name: 'Согласовать и начать выполнение', exact: true })).toBeEnabled();
    // Required plan criteria must remain inspectable before approval after the wide rail is removed.
    for (const requirement of fixture.plan.taskContract.requirements) await expect(book(page)).toContainText(requirement.title);
    await selectStep(page, 'implement');
    await expect(stepDetails(page).getByRole('heading', { name: 'Создать форму регистрации', exact: true })).toBeVisible();
    await expect(stepDetails(page).locator('.fact-list')).toContainText('approve-plan');
    await fits(page); await openDiagnostics(page, 'result'); await expect(page.locator('.workflow-steps > li')).toHaveCount(4);
  });
}

test('wide plan approval uses unchanged challenge, hash, permissions and revision', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); const f = widePlanFixture(); const api = await mount(page, f);
  await book(page).getByRole('button', { name: 'Согласовать и начать выполнение', exact: true }).click();
  const call = api.calls.find(item => item.action === 'gate'); expect(call.body.challenge).toBe(f.state.gates[0].challenge);
  expect(call.body.planHash).toBe(f.state.planHash); expect(call.body.expectedRevision).toBe(f.state.revision);
  expect(call.body.permissions).toEqual(f.state.gates[0].requiredPermissions);
});

test('feedback survives resizing and keeps approval disabled until a revised plan exists', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); const api = await mount(page, widePlanFixture());
  await page.getByText('Предложить изменения плана', { exact: true }).click();
  const field = page.getByLabel('Что дополнить или исправить?'); await field.fill('Добавить проверку ИНН');
  await page.setViewportSize({ width: 1920, height: 1080 }); await expect(field).toHaveValue('Добавить проверку ИНН');
  await expect(book(page).getByRole('button', { name: 'Согласовать и начать выполнение', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 }); await expect(field).toHaveValue('Добавить проверку ИНН');
  await field.focus(); await expect(field).toBeFocused(); expect(api.calls).toHaveLength(0); await fits(page);
});

test('closed diagnostics stays closed across live revisions and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); const api = await mount(page, widePlanFixture('running'));
  await closeSurface(page); await expect(book(page)).toHaveCount(0);
  const activeInWorld = await page.evaluate(() => Boolean(document.activeElement && document.querySelector('.rpg-shell')?.contains(document.activeElement) && document.activeElement !== document.body));
  expect(activeInWorld).toBe(true);
  const reads = api.snapshotReads(); api.current().revision++; await expect.poll(() => api.snapshotReads()).toBeGreaterThan(reads);
  await expect(book(page)).toHaveCount(0);
});

test('wide unavailable and malformed proof state remains fail-closed', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); const f = wideProofFixture(); f.state.integrity = { valid: false, reason: 'Целостность не подтверждена' };
  await mount(page, f); await expect(page.getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(page.locator('.completion-certificate')).toHaveCount(0); await expect(page.getByTestId('requirement-coverage')).toHaveCount(0);
});

test('proof selection, stale evidence and human-acceptance input survive wide resize', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); const f = wideProofFixture(true); const proof = f.state.proof;
  proof.requirements[1].verification.method = 'human'; proof.requirements[1].status = 'unproven'; proof.acceptance = { allowed: true, reason: null, challenge: 'human-wide-challenge' };
  await mount(page, f);
  await page.getByRole('button', { name: /Для компании показаны название и ИНН Нужна проверка/ }).click();
  const reason = page.getByLabel('Что вы проверили и чем подтверждается результат?'); await reason.fill('Проверены обязательные поля формы');
  await page.setViewportSize({ width: 1920, height: 1080 }); await expect(reason).toHaveValue('Проверены обязательные поля формы');
  await expect(page.getByRole('region', { name: 'Доказательство требования' }).getByRole('heading', { name: 'Для компании показаны название и ИНН', exact: true })).toBeVisible();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Нужна повторная проверка'); await expect(page.locator('.completion-certificate')).toHaveCount(0);
});

test('wide gate remains actionable when its contract already has unproven proof', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); const f = widePlanFixture(); const p = wideProofFixture(true).state.proof;
  p.status = 'UNPROVEN'; p.contract = f.plan.taskContract; f.state.proof = p;
  await mount(page, f);
  await expect(book(page).getByRole('button', { name: 'Согласовать и начать выполнение', exact: true })).toBeEnabled();
  await expect(page.getByTestId('task-proof-status')).toHaveText('План ожидает согласования');
  for (const requirement of f.plan.taskContract.requirements) await expect(book(page)).toContainText(requirement.title);
});

test('missing contract does not invent verification methods', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); const f = widePlanFixture(); delete f.plan.taskContract;
  f.state.planHash = objectHash(f.plan); f.state.gates[0].planHash = f.state.planHash;
  await mount(page, f);
  // Absence must be stated; simply hiding the former contract view does not satisfy this check.
  await expect(book(page)).toContainText('Способ проверки не указан');
  await expect(book(page)).toContainText('Исходные критерии задачи');
  for (const criterion of f.state.task.acceptance) await expect(book(page)).toContainText(criterion);
});

test('new task and loading fit wide and smaller frames', async ({ page }) => {
  await page.setViewportSize({ width: 3440, height: 1440 }); const f = widePlanFixture(); await mount(page, f, { emptyUntilIntake: true, projectDelayMs: 1000, listDelayMs: 1000 });
  await expect(page.getByTestId('rpg-runtime-status')).toContainText('Загружаем проект');
  await newQuest(page);
  await expect(page.getByRole('heading', { name: 'Новое поручение', exact: true })).toBeVisible(); await fits(page);
  for (const width of [1799, 1366, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('heading', { name: 'Новое поручение', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Название', exact: true })).toBeVisible(); await fits(page);
  }
});
