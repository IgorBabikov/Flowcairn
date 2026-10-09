import { test, expect } from '@playwright/test';
import { fixture as learningFixture, hash } from '../src/learning/learning-fixtures.test-support.mjs';
import { mockApi, snapshot, token } from './fixtures.mjs';

// Synthetic HTTP responses exercise the production reader, decoder, dialog and CSS.
async function openReader(page, viewport, contextLines = 100) {
  await page.setViewportSize(viewport);
  const f = learningFixture();
  const text = [
    'export function createSearch(load, show) {', '  let latest = 0;',
    '  return async function search(query) {', '    const request = ++latest;', '    try {',
    '      const products = await load(query);', '      if (request !== latest) return;',
    '      show({ products, error: null });', '    } catch {', '      if (request !== latest) return;',
    "      show({ products: [], error: 'Ошибка поиска' });", '    }', '  };', '}',
    ...Array.from({ length: contextLines }, (_, i) => `// Saved context line ${i + 15}: ${'long source context '.repeat(6)}`),
  ].join('\n');
  const lines = text.split('\n');
  const source = { ...f.source, path: 'src/search.js', bytes: Buffer.byteLength(text), lineCount: lines.length };
  const anchor = (startLine, endLine) => ({ sourceId: source.id, fileHash: source.fileHash,
    startLine, endLine, quote: lines.slice(startLine - 1, endLine).join('\n') });
  const material = { ...f.response.material, planHash: snapshot().planHash, sourceCatalogHash: hash({ version: 1, sources: [source] }) };
  const materialHash = hash(material);
  const steps = [anchor(3, 8), anchor(9, 12)].map((quote, i) => ({ ...f.lesson.steps[0], id: `step-${i}`,
    title: i ? 'Ошибка старого запроса' : 'Новый запрос', anchors: [quote],
    transformations: Array.from({ length: 12 }, (_, n) => `Переход ${n + 1}: запрос сохраняет свой номер, а новый ввод увеличивает общий счетчик. После ответа сравниваем номера перед обновлением списка товаров.`),
    origin: { ...f.lesson.steps[0].origin, anchor: quote } }));
  const lesson = { ...f.lesson, materialHash, steps, questions: [] };
  const lessonHash = hash(lesson);
  const response = { ...f.response, id: materialHash, material, sources: [source], lessonHash };
  const state = { ...snapshot(), ...f.snapshot, planHash: material.planHash,
    approvalExpiresAt: Date.now() + 3600000,
    continuation: { ...f.snapshot.continuation, materialHash },
    learning: { ...f.snapshot.learning, stages: [{ ...f.snapshot.learning.stages[0], materialHash, lessonHash }] } };
  const api = await mockApi(page, state);
  await page.route('**/api/runs/*/learning/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/materials/${materialHash}`)) return route.fulfill({ json: response });
    if (url.pathname.endsWith(`/lessons/${lessonHash}`)) return route.fulfill({ json: { id: lessonHash, lesson } });
    if (url.pathname.endsWith(`/sources/${source.id}`)) {
      const startLine = Number(url.searchParams.get('startLine'));
      const lineCount = Number(url.searchParams.get('lineCount'));
      const endLine = Math.min(lines.length, startLine + lineCount - 1);
      return route.fulfill({ json: { sourceId: source.id, fileHash: source.fileHash,
        text: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine, totalLines: lines.length,
        next: endLine < lines.length ? { startLine: endLine + 1, lineCount } : null } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Test resource missing' } } });
  });
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Карта этапов и разбор', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть сохраненный материал', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Новый запрос', exact: true })).toBeVisible();
  await expect(page.locator('.saved-code [data-line="1"]')).toBeAttached();
  return api;
}

test('next and previous lesson steps open at their beginning with context and keyboard focus', async ({ page }) => {
  const api = await openReader(page, { width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Следующий шаг разбора', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Ошибка старого запроса', exact: true });
  await expect(heading).toBeFocused();
  await expect.poll(() => page.locator('.codex-explanation').evaluate(el => el.scrollTop)).toBe(0);
  await expect(heading).toBeInViewport();
  await expect(page.locator('.saved-code [data-line="1"]')).toContainText('createSearch');
  await expect(page.locator('.saved-code [data-line="2"]')).toContainText('latest = 0');
  await expect(page.locator('.source-line-selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Предыдущий шаг разбора', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Новый запрос', exact: true })).toBeFocused();
  await expect.poll(() => page.locator('.codex-explanation').evaluate(el => el.scrollTop)).toBe(0);
  expect(api.calls).toEqual([]);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 720, height: 450 }]) {
  test(`compact reading preserves both positions and quote navigation at ${viewport.width}`, async ({ page }) => {
    const api = await openReader(page, viewport);
    const dialog = page.getByRole('dialog', { name: 'Сохраненный разбор', exact: true });
    const nav = page.getByRole('navigation', { name: 'Переходы по книге' });
    await dialog.evaluate(el => el.scrollTo({ top: 500 }));
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(500);
    await nav.getByRole('button', { name: 'Код', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Объяснение', exact: true })).toBeHidden();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(0);
    expect(await page.locator('.saved-code').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await dialog.evaluate(el => el.scrollTo({ top: 350 }));
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(350);
    await page.locator('.saved-code').evaluate(el => { el.scrollLeft = 80; });
    await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(500);
    await nav.getByRole('button', { name: 'Код', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(350);
    await expect.poll(() => page.locator('.saved-code').evaluate(el => el.scrollLeft)).toBe(80);
    await nav.getByRole('button', { name: 'Продолжение', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Продолжить работу', exact: true })).toBeInViewport();
    await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(500);
    await page.getByRole('button', { name: 'Исходник · строки 3–8', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Код', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(0);
    await expect.poll(() => page.locator('.saved-code').evaluate(el => el.scrollLeft)).toBe(0);
    await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
    await page.getByRole('button', { name: 'Следующий шаг разбора', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Ошибка старого запроса', exact: true })).toBeFocused();
    expect(api.calls).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Карта этапов и разбор', exact: true })).toBeFocused();
  });
}

test('expanded code survives reflow and compact page switches keep a question draft', async ({ page }) => {
  await openReader(page, { width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Развернуть код', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Объяснение', exact: true })).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  const nav = page.getByRole('navigation', { name: 'Переходы по книге' });
  await expect(nav.getByRole('button', { name: 'Код', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Задать вопрос по этому месту', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ваш вопрос', exact: true }).fill('Почему старый ответ игнорируется?');
  await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
  await nav.getByRole('button', { name: 'Код', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ваш вопрос', exact: true })).toHaveValue('Почему старый ответ игнорируется?');
  await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('region', { name: 'Объяснение', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Код', exact: true })).toBeVisible();
});

test('a short code page cannot clamp the remembered position in a longer explanation', async ({ page }) => {
  await openReader(page, { width: 390, height: 844 }, 0);
  const dialog = page.getByRole('dialog', { name: 'Сохраненный разбор', exact: true });
  const nav = page.getByRole('navigation', { name: 'Переходы по книге' });
  await page.mouse.move(180, 500);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(600);
  for (let cycle = 0; cycle < 3; cycle++) {
    await nav.getByRole('button', { name: 'Код', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(0);
    await nav.getByRole('button', { name: 'Объяснение', exact: true }).click();
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBe(600);
  }
});

test('large saved file and a long Unicode line remain readable through explicit continuation', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const f = learningFixture(), first = 'Я💡'.repeat(10922), tail = 'LAST_SOURCE_CHARACTER';
  const text = first.repeat(5) + tail;
  const source = { ...f.source, path: 'src/large.txt', bytes: Buffer.byteLength(text), lineCount: 1,
    chunkIndexHash: 'a'.repeat(64) };
  delete source.chunkHashes;
  const material = { ...f.response.material, status: 'complete', gaps: [], planHash: snapshot().planHash,
    sourceCatalogHash: hash({ version: 1, sources: [source] }) };
  // JSON serialization omits undefined optional chunkHashes just like the runtime DTO.
  const materialHash = hash(material), response = { ...f.response, id: materialHash, material, sources: [source], lessonHash: null };
  const state = { ...snapshot(), ...f.snapshot, planHash: material.planHash,
    approvalExpiresAt: Date.now() + 3600000, continuation: { ...f.snapshot.continuation, materialHash },
    learning: { ...f.snapshot.learning, stages: [{ ...f.snapshot.learning.stages[0], materialHash, lessonHash: null }] } };
  const api = await mockApi(page, state);
  const columns = [];
  await page.route('**/api/runs/*/learning/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/materials/${materialHash}`)) return route.fulfill({ json: response });
    if (url.pathname.endsWith(`/sources/${source.id}`)) {
      const startColumn = Number(url.searchParams.get('startColumn') ?? 0); columns.push(startColumn);
      const value = text.slice(startColumn, startColumn + first.length);
      const endColumn = startColumn + value.length, partial = endColumn < text.length;
      return route.fulfill({ json: { sourceId: source.id, fileHash: source.fileHash, text: value, startLine: 1, endLine: 1,
        totalLines: 1, startColumn, endColumn, partial, next: partial ? { startLine: 1, lineCount: 100, startColumn: endColumn } : null } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Test resource missing' } } });
  });
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Карта этапов и разбор', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть сохраненный материал', exact: true }).click();
  await expect.poll(() => page.locator('.saved-code').textContent()).toBe(first);
  await expect(page.getByText(/Строка 1 показана частями/)).toBeVisible();
  const next = page.getByRole('button', { name: 'Следующие строки', exact: true });
  for (let i = 0; i < 5; i++) { await next.click(); await expect.poll(() => columns.at(-1)).toBe((i + 1) * first.length); }
  await expect(page.locator('.saved-code')).toContainText(tail); await expect(next).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Задать вопрос по этому месту', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Предыдущие строки', exact: true }).click();
  await expect.poll(() => columns.at(-1)).toBe(0);
  expect(api.calls).toEqual([]);
});
