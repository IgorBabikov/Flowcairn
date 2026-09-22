import { expect, test } from '@playwright/test';
import { mockApi, snapshot, allowed, allDenied, token, projectContext } from './fixtures.mjs';

const missingPreview = {
  contextHash: projectContext.contextHash, previewHash: 'f'.repeat(64), scope: ['src'],
  candidates: ['src', 'dictionaries/catalog.json'], ready: false, feedback: [],
  references: [{ reference: 'catalog.json', status: 'missing', matches: [] }],
  issues: ['Укажите, какой файл catalog.json нужен задаче.'],
};

function stoppedTask() {
  const current = snapshot();
  current.phase = 'planning'; current.workflow = 'autonomous';
  current.status = 'uncertain'; current.resolutionKind = 'semantic'; current.contextClarification = true;
  current.task = { ...current.task, title: 'Перенести словарь', description: 'Перенести catalog.json в src.' };
  current.gates = []; current.capabilities = { ...allDenied, requestReplan: allowed };
  current.nodes[0] = { ...current.nodes[0], status: 'uncertain', resolutionKind: 'semantic', reason: 'Нужно указать catalog.json' };
  return current;
}

async function openClarification(page) {
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Уточнить контекст', exact: true }).click();
}

test('a protected reference can be acknowledged as a constraint without gaining access', async ({ page }) => {
  await mockApi(page, stoppedTask());
  let selection;
  await page.route('**/api/intake/preview', async route => {
    selection = route.request().postDataJSON().selection;
    await route.fulfill({ json: { ...missingPreview, ready: Boolean(selection), issues: [],
      references: [{ reference: '.env', status: 'unavailable', matches: [] }] } });
  });
  await openClarification(page);
  const choices = page.getByLabel('Как использовать .env');
  await expect(choices.locator('option[value="existing"], option[value="create"]')).toHaveCount(0);
  await choices.selectOption('example');
  await page.getByRole('button', { name: 'Проверить контекст снова' }).click();
  await expect(page.getByRole('button', { name: 'Продолжить анализ' })).toBeEnabled();
  expect(selection.resolutions).toEqual([{ reference: '.env', kind: 'example' }]);
  expect(selection.scope).not.toContain('.env');
});

test('ordinary task starts in one submission without a scope chooser or preview request', async ({ page }) => {
  const fixture = await mockApi(page, snapshot(), { emptyUntilIntake: true });
  await page.goto(`/#session=${token}`);
  const form = page.locator('.task-composer form');
  await expect(form.locator('input, textarea, select')).toHaveCount(3);
  await page.getByLabel('Заголовок задачи', { exact: true }).fill('Перенести словарь');
  await page.getByLabel('Полное описание задачи', { exact: true }).fill('Перенести catalog.json в src.');
  await page.getByLabel('Номер задачи', { exact: true }).fill('CONTEXT-1');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect.poll(() => fixture.calls.filter(call => call.action === 'intake').length).toBe(1);
  expect(fixture.calls.filter(call => call.action === 'preview')).toHaveLength(0);
  expect(fixture.calls.find(call => call.action === 'intake').body.selection).toBeUndefined();
  await expect(page.locator('.task-context-picker')).toHaveCount(0);
});

test('exceptional context correction keeps run/revision binding and requires recheck after edits', async ({ page }) => {
  const current = stoppedTask();
  const fixture = await mockApi(page, current);
  const controls = [];
  await page.route('**/api/intake/preview', async route => {
    const body = route.request().postDataJSON();
    const ready = body.selection?.resolutions[0]?.path === 'dictionaries/catalog.json';
    await route.fulfill({ json: { ...missingPreview, ready, issues: ready ? [] : missingPreview.issues } });
  });
  await page.route('**/control/replan', async route => {
    controls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { result: { ...current, contextClarification: false, status: 'ready', revision: current.revision + 1 } } });
  });
  await openClarification(page);
  await expect(page.getByRole('heading', { name: 'Уточнить контекст задачи' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Продолжить анализ' })).toBeDisabled();
  await page.getByLabel('Как использовать catalog.json').selectOption('existing');
  await page.getByLabel('Путь существующего файла', { exact: true }).fill('dictionaries/catalog.json');
  await page.getByRole('button', { name: 'Проверить контекст снова' }).click();
  await expect(page.getByRole('button', { name: 'Продолжить анализ' })).toBeEnabled();
  await page.getByLabel('Файлы и папки задачи').fill('src\ndocs');
  await expect(page.getByRole('button', { name: 'Продолжить анализ' })).toBeDisabled();
  await page.getByRole('button', { name: 'Проверить контекст снова' }).click();
  await page.getByLabel('Дополнение к задаче (необязательно)').fill('Словарь находится в dictionaries.');
  await page.getByRole('button', { name: 'Продолжить анализ' }).click();
  await expect.poll(() => controls.length).toBe(1);
  expect(controls[0].url).toContain(`/api/runs/${current.runId}/control/replan`);
  expect(controls[0].body).toMatchObject({ expectedRevision: current.revision, planHash: current.planHash,
    feedback: 'Словарь находится в dictionaries.', contextSelection: {
      contextHash: missingPreview.contextHash, previewHash: missingPreview.previewHash,
      resolutions: [{ reference: 'catalog.json', kind: 'existing', path: 'dictionaries/catalog.json' }],
    } });
  expect(controls[0].body.contextSelection.scope).toContain('dictionaries/catalog.json');
  expect(fixture.calls.filter(call => call.action === 'intake')).toHaveLength(0);
});

test('canceling optional recovery discards a late preview without losing the task', async ({ page }) => {
  const fixture = await mockApi(page, stoppedTask());
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/intake/preview', async route => {
    started = true; await held; await route.fulfill({ json: missingPreview });
  });
  await openClarification(page);
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: 'Вернуться к задаче' }).click();
  release();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Нужно уточнение');
  await expect(page.locator('.task-context-picker')).toHaveCount(0);
  expect(fixture.calls.filter(call => call.action === 'replan')).toHaveLength(0);
});

test('optional recovery retries failed read-only preview and rejects malformed responses', async ({ page }) => {
  await mockApi(page, stoppedTask());
  let count = 0;
  await page.route('**/api/intake/preview', async route => {
    count += 1;
    if (count === 1) { await route.abort('connectionreset'); return; }
    if (count === 2) { await route.fulfill({ json: { ready: true } }); return; }
    await route.fulfill({ json: missingPreview });
  });
  await openClarification(page);
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось прочитать проверку контекста');
  await expect(page.getByRole('button', { name: 'Продолжить анализ' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expect(page.getByLabel('Как использовать catalog.json')).toBeVisible();
});

test('optional recovery refreshes a stale preview without replacing the original description', async ({ page }) => {
  await mockApi(page, stoppedTask());
  let count = 0;
  const calls = [];
  await page.route('**/api/intake/preview', async route => {
    count += 1; calls.push(route.request().postDataJSON());
    if (count === 2) { await route.fulfill({ status: 409, json: { error: { code: 'STALE_CONTEXT', message: 'Проект изменился. Обновите контекст.' } } }); return; }
    await route.fulfill({ json: { ...missingPreview, previewHash: count === 3 ? 'b'.repeat(64) : missingPreview.previewHash } });
  });
  await openClarification(page);
  await page.getByRole('button', { name: 'Проверить контекст снова' }).click();
  await page.getByRole('button', { name: 'Обновить контекст проекта', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить контекст снова' })).toBeVisible();
  expect(calls[2].selection).toBeUndefined();
  expect(calls[2].description).toBe('Перенести catalog.json в src.');
});

test('optional recovery remains usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, stoppedTask());
  await page.route('**/api/intake/preview', route => route.fulfill({ json: missingPreview }));
  await openClarification(page);
  await page.getByLabel('Как использовать catalog.json').selectOption('create');
  await page.getByLabel('Путь нового файла').fill('src/catalog.json');
  await page.getByRole('button', { name: 'Проверить контекст снова' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Проверить контекст снова' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
