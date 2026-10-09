import { expect } from '@playwright/test';
import { token } from './fixtures.mjs';

export const book = page => page.getByTestId('diagnostic-book');
export const stepPicker = page => page.getByTestId('diagnostic-node-select');
export const stepDetails = page => page.getByTestId('diagnostic-node-details');

export async function closeSurface(page) {
  await expect(page.locator('dialog[open]:not(.game-overlay)')).toHaveCount(0);
  if (await page.locator('.game-overlay[open]').count()) {
    // Normal navigation waits for the surface to allow closing. Tests of the
    // pending/uncertain guard send Escape directly instead of using this helper.
    const close = page.locator('.game-overlay[open] .game-close');
    await expect(close).toBeVisible();
    await expect(close).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.game-overlay[open]')).toHaveCount(0);
  }
}

export async function openDiagnostics(page, chapter = 'result') {
  if (!(await book(page).isVisible())) {
    await closeSurface(page);
    await page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('dialog', { name: 'Служебные записи', exact: true }).getByRole('button', { name: 'Книга диагностики', exact: true }).click();
    await expect(book(page)).toBeVisible();
  }
  await book(page).locator(`#diagnostic-tab-${chapter}`).click();
  await expect(book(page).locator(`#diagnostic-tab-${chapter}`)).toHaveAttribute('aria-selected', 'true');
  return book(page);
}

export async function visitResult(page) {
  await page.goto(`/#session=${token}`);
  return openDiagnostics(page, 'result');
}

export async function openJournal(page) {
  await closeSurface(page);
  await page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Журнал', exact: true }).click();
  const journal = page.getByRole('dialog', { name: 'Журнал поручений', exact: true });
  await expect(journal).toBeVisible();
  return journal;
}

export async function openQuest(page) {
  await closeSurface(page);
  await page.getByRole('complementary', { name: 'Текущее поручение' }).getByRole('button', { name: /^(Проверить план|Открыть поручение|В Гильдию)$/ }).click();
  return page.locator('.game-overlay[open]');
}

export async function newQuest(page) {
  const journal = await openJournal(page);
  await journal.getByRole('button', { name: /^(Новое поручение|Создать поручение)$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Новое поручение', exact: true })).toBeVisible();
}

export async function visitNewQuest(page) {
  await page.goto(`/#session=${token}`);
  await newQuest(page);
}

export async function selectRun(page, label, chapter = 'result') {
  const journal = await openJournal(page);
  const entry = journal.locator('.journal-entry').filter({ hasText: label });
  await expect(entry).toHaveCount(1);
  await entry.click();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  await journal.getByRole('button', { name: 'Открыть поручение', exact: true }).click();
  return openDiagnostics(page, chapter);
}

export async function selectStep(page, nodeId) {
  await openDiagnostics(page, 'nodes');
  await stepPicker(page).selectOption(nodeId);
  await expect(stepPicker(page)).toHaveValue(nodeId);
}

export async function selectStepByText(page, title) {
  await openDiagnostics(page, 'nodes');
  const options = await stepPicker(page).locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
  const matching = options.filter(item => item.value && item.text.includes(title));
  expect(matching, `Unique step matching ${title}`).toHaveLength(1);
  await stepPicker(page).selectOption(matching[0].value);
}

export async function showVersion(page) {
  const details = book(page).locator('.diagnostic-version');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return details;
}
