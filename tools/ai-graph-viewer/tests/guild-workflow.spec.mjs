import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuildFixture, guildGoal, guildInstruction } from './guild-workflow-fixture.mjs';
import { closeSurface, newQuest, openDiagnostics, openQuest } from './ui-paths.mjs';

const qa = fileURLToPath(new URL('../../../output/product-completion/rpg/qa', import.meta.url));
test.skip(!process.env.FLOWCAIRN_GUILD_DIST, 'Set FLOWCAIRN_GUILD_DIST to a prepared integrated viewer build');
const world = page => page.getByTestId('guild-world');
const activity = (page, action) => page.locator(`.guild-activity[data-action="${action}"]`);
const counts = f => f.calls.map(item => item.action);
async function visit(page, f) { await page.goto(`${f.url}/#session=${f.token}`); await expect(world(page)).toBeVisible(); }
async function startThroughUI(page) {
  await newQuest(page);
  await page.getByLabel('Название', { exact: true }).fill(guildGoal);
  await page.getByLabel('Что нужно сделать', { exact: true }).fill(guildInstruction);
  await page.getByLabel('Номер задачи', { exact: true }).fill('GUILD-TEST-ONLY');
  await page.getByRole('button', { name: 'Начать анализ', exact: true }).click();
}
async function pending(f, action) {
  await expect.poll(() => f.pending().some(item => item.action === action), { message: `Real service starts ${action}` }).toBe(true);
  return f.pending().find(item => item.action === action);
}
async function assertRunning(page, f, action) {
  const held = await pending(f, action);
  await closeSurface(page);
  await expect(world(page)).toHaveAttribute('data-paused', 'false');
  const row = page.locator(`.guild-activity[data-node-id="${held.nodeId}"]`);
  await expect(row).toHaveAttribute('data-worker-state', 'running');
  return held;
}
async function approveThroughUI(page, f) {
  await expect.poll(() => f.current()?.gates.some(item => item.type === 'approve-plan')).toBe(true);
  await openQuest(page);
  await page.getByRole('button', { name: 'Согласовать и начать выполнение', exact: true }).click();
}
async function finishHeld(f) {
  for (let i = 0; i < 12; i++) {
    await expect.poll(() => f.pending().length > 0 || f.current()?.proof.status === 'PROVEN').toBe(true);
    if (f.current()?.proof.status === 'PROVEN') return;
    f.release();
  }
  throw Error('Fixture exceeded bounded action count');
}
function saveEvidence(f, name) { mkdirSync(qa, { recursive: true }); writeFileSync(path.join(qa, `${name}.json`), JSON.stringify(f.evidence(), null, 2)); }

test('actual UI intake, immutable approval, real file/check repair, PROVEN and preserved source book', async ({ page }, testInfo) => {
  const f = await createGuildFixture({ repair: true, hold: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await visit(page, f); await startThroughUI(page);
    let held = await assertRunning(page, f, 'ai-analyze'); f.release(held.index);
    held = await assertRunning(page, f, 'ai-plan'); f.release(held.index);
    await approveThroughUI(page, f);
    held = await assertRunning(page, f, 'ai-implement');
    expect(f.counts.implement).toBe(0); // Held AI response has not authorized any patch yet.
    expect(readFileSync(path.join(f.root, 'counter.json'), 'utf8')).toBe('0\n');
    await page.screenshot({ path: testInfo.outputPath('guild-actual-implement.png'), fullPage: true });
    f.release(held.index);
    held = await assertRunning(page, f, 'check-counter'); f.release(held.index);
    held = await assertRunning(page, f, 'ai-implement');
    expect(f.observations.some(item => item.exitCode !== 0 && item.value === '1\n')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('guild-actual-repair.png'), fullPage: true });
    f.release(held.index); await finishHeld(f);
    await expect.poll(() => f.current()?.proof.status).toBe('PROVEN');
    saveEvidence(f, 'actual-ui-repair');
    await expect(world(page)).toHaveAttribute('data-completed', 'true');
    expect(f.counts.implement).toBe(2);
    expect(f.observations.some(item => item.exitCode === 0 && item.value === '2\n')).toBe(true);
    await openQuest(page);
    await page.getByRole('button', { name: 'Карта этапов и разбор', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть итоговый материал', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Сохраненный разбор', exact: true })).toBeVisible();
    await expect(page.locator('.game-overlay[open]')).toContainText('counter.json');
    await page.screenshot({ path: testInfo.outputPath('guild-source-book.png'), fullPage: true });
    expect(errors).toEqual([]); saveEvidence(f, 'actual-ui-repair');
    await closeSurface(page);
    writeFileSync(path.join(f.root, 'counter.json'), '3\n');
    await page.reload(); await expect(world(page)).toHaveAttribute('data-completed', 'false');
    expect(f.current().proof.certificate).toBe(null);
  } finally { await f.close(); }
});

test('fresh observed dependency start emits once; reload and archive do not replay old handoffs or commands', async ({ page }, testInfo) => {
  const f = await createGuildFixture({ hold: true });
  const posts = []; page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
  try {
    await visit(page, f); await startThroughUI(page);
    const analyze = await assertRunning(page, f, 'ai-analyze');
    const before = Number(await world(page).getAttribute('data-handoff-count') ?? 0);
    f.release(analyze.index); await assertRunning(page, f, 'ai-plan');
    await expect.poll(async () => Number(await world(page).getAttribute('data-handoff-count'))).toBeGreaterThan(before);
    const observed = Number(await world(page).getAttribute('data-handoff-count'));
    await page.screenshot({ path: testInfo.outputPath('guild-fresh-dependency.png'), fullPage: true });
    const callsBeforeReload = [...counts(f)], postsBefore = posts.length;
    await page.reload(); await expect(world(page)).toBeVisible();
    await expect(activity(page, 'ai-plan')).toHaveAttribute('data-worker-state', 'running');
    expect(Number(await world(page).getAttribute('data-handoff-count') ?? 0)).toBe(0);
    expect(counts(f)).toEqual(callsBeforeReload); expect(posts.length).toBe(postsBefore);
    expect(observed).toBeGreaterThan(0);
    f.release(); await approveThroughUI(page, f);
    const implement = await assertRunning(page, f, 'ai-implement');
    const beforeCheck = Number(await world(page).getAttribute('data-handoff-count') ?? 0);
    f.release(implement.index); await assertRunning(page, f, 'check-counter');
    await expect.poll(async () => Number(await world(page).getAttribute('data-handoff-count'))).toBeGreaterThan(beforeCheck);
    await page.screenshot({ path: testInfo.outputPath('guild-mage-checker-dependency.png'), fullPage: true });
    const checkCalls = [...counts(f)];
    await page.reload(); await expect(activity(page, 'check-counter')).toHaveAttribute('data-worker-state', 'running');
    expect(Number(await world(page).getAttribute('data-handoff-count') ?? 0)).toBe(0);
    expect(counts(f)).toEqual(checkCalls);
    f.release(); await finishHeld(f);
    const completedCalls = [...counts(f)];
    await page.reload(); await expect(world(page)).toHaveAttribute('data-completed', 'true');
    expect(Number(await world(page).getAttribute('data-handoff-count') ?? 0)).toBe(0);
    expect(counts(f)).toEqual(completedCalls);
    await openDiagnostics(page, 'history');
    await expect(page.getByTestId('diagnostic-book')).toContainText(guildGoal);
    expect(counts(f)).toEqual(completedCalls);
    saveEvidence(f, 'handoff-reload');
  } finally { await f.close(); }
});

test('keyboard book and retained controls work with reduced motion, narrow viewport and 200% layout equivalent', async ({ page }, testInfo) => {
  const f = await createGuildFixture();
  try {
    await f.intake(); await f.settle(); await visit(page, f);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [label, width, height, zoom] of [['desktop', 1440, 900, 1], ['narrow', 390, 844, 1], ['zoom-200', 720, 450, 2]]) {
      // 720x450 CSS viewport is the effective layout at 200% on a 1440x900 display.
      await page.setViewportSize({ width, height });
      await closeSurface(page); await expect(world(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const settings = page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Настройки', exact: true });
      await settings.focus(); await page.keyboard.press('Enter');
      const openBook = page.getByRole('button', { name: 'Книга диагностики', exact: true });
      await openBook.focus(); await page.keyboard.press('Enter');
      const book = page.getByTestId('diagnostic-book'); await expect(book).toBeVisible();
      await book.locator('#diagnostic-tab-result').focus(); await page.keyboard.press('ArrowRight');
      await expect(book.locator('#diagnostic-tab-nodes')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape'); await expect(book).not.toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`guild-${label}.png`), fullPage: true });
      testInfo.annotations.push({ type: 'layout', description: `${label}: ${width}x${height} CSS px; zoom equivalence ${zoom}` });
    }
    expect(f.counts.implement).toBe(0);
  } finally { await f.close(); }
});

test('asset/renderer failure leaves actual task approval and diagnostic DOM usable', async ({ page }, testInfo) => {
  const f = await createGuildFixture();
  try {
    await f.intake(); await f.settle();
    await page.route('**/assets/rpg/guild*.png', route => route.abort());
    await visit(page, f);
    await expect(world(page)).toHaveAttribute('data-renderer-state', 'failed');
    await openQuest(page);
    await expect(page.getByRole('button', { name: 'Согласовать и начать выполнение', exact: true })).toBeEnabled();
    await openDiagnostics(page, 'nodes');
    await expect(page.getByTestId('diagnostic-node-select')).toBeVisible();
    expect(f.counts.implement).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('guild-renderer-fallback.png'), fullPage: true });
  } finally { await f.close(); }
});
