import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuildFixture } from './guild-workflow-fixture.mjs';
import { allDenied, graphNode, mockApi, snapshot, token } from './fixtures.mjs';

test.skip(!process.env.FLOWCAIRN_GUILD_DIST, 'Set FLOWCAIRN_GUILD_DIST to an integrated viewer build');

test('six synthetic projected actors fit frame target; simulated visibility signal stops actual rendering', async ({ page }, testInfo) => {
  const f = await createGuildFixture();
  try {
    // Performance-only presentation fixture. These are not claimed to be six executor processes.
    const state = snapshot(); state.status = 'running'; state.gates = []; state.proof = null;
    state.capabilities = allDenied; state.activeNodeId = 'worker-0';
    state.execution = { state: 'running', stopRequested: false };
    state.nodes = ['ai-analyze', 'ai-implement', 'check-counter', 'ai-review', 'human-approve', 'ai-implement'].map((action, index) => graphNode({
      id: `worker-${index}`, title: `TEST ONLY worker ${index}`, action: { id: action, kind: action.startsWith('ai-') ? 'ai' : 'check' },
      needs: [], status: 'running', attempt: 1, startedAt: new Date().toISOString(), receiptIds: [], artifacts: [], capabilities: allDenied,
    }));
    state.edges = [];
    const api = await mockApi(page, state);
    await page.goto(`${f.url}/#session=${token}`);
    const world = page.getByTestId('guild-world');
    await expect(world).toHaveAttribute('data-renderer-state', 'ready');
    await expect(world).toHaveAttribute('data-actor-count', '6');
    await expect.poll(async () => Number(await world.getAttribute('data-render-count')), { timeout: 60000 }).toBeGreaterThan(300);
    const afterWarmup = Number(await world.getAttribute('data-render-count'));
    await expect.poll(async () => Number(await world.getAttribute('data-render-count')), { timeout: 60000 }).toBeGreaterThan(afterWarmup + 180);
    const measured = {
      label: 'TEST ONLY: six projected assignments, not six real executor workers',
      actorCount: Number(await world.getAttribute('data-actor-count')),
      warmupRenders: afterWarmup, measuredAfterRenders: Number(await world.getAttribute('data-render-count')), p95WindowFrames: 180,
      frameP95Ms: Number(await world.getAttribute('data-frame-p95-ms')),
      cpuRenderP95Ms: Number(await world.getAttribute('data-render-p95-ms')),
      userAgent: await page.evaluate(() => navigator.userAgent), viewport: page.viewportSize(),
      machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, memoryGiB: os.totalmem() / 2 ** 30, node: process.version },
      webgl: await page.locator('[data-testid="guild-world"] canvas').evaluate(canvas => {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), vendor: gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR), version: gl.getParameter(gl.VERSION) };
      }),
    };
    await testInfo.attach('measured-performance', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    const qa = fileURLToPath(new URL('../../../output/product-completion/rpg/qa', import.meta.url));
    mkdirSync(qa, { recursive: true }); writeFileSync(path.join(qa, 'performance.json'), JSON.stringify(measured, null, 2));
    await page.screenshot({ path: testInfo.outputPath('guild-six-synthetic-assignments.png'), fullPage: true });
    // Playwright keeps all pages visible through focus emulation, including headed.
    // This explicitly simulated signal checks the real pause handler/render counter.
    // Native hidden-tab acceptance remains a separate browser check, not a PASS here.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(world).toHaveAttribute('data-paused', 'true');
    const stoppedAt = Number(await world.getAttribute('data-render-count'));
    await page.waitForTimeout(500);
    expect(Number(await world.getAttribute('data-render-count'))).toBe(stoppedAt);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden'); Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(world).toHaveAttribute('data-paused', 'false');
    await expect.poll(async () => Number(await world.getAttribute('data-render-count'))).toBeGreaterThan(stoppedAt);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(world).toHaveAttribute('data-paused', 'true');
    expect(api.calls).toEqual([]);
    expect(measured.frameP95Ms).toBeGreaterThan(0);
    const softwareRenderer = measured.webgl?.renderer?.includes('SwiftShader');
    if (softwareRenderer) testInfo.annotations.push({ type: 'performance-unverified', description: `SwiftShader renderer; observed p95 ${measured.frameP95Ms}ms is not hardware acceptance.` });
    else expect(measured.frameP95Ms).toBeLessThanOrEqual(33);
    expect(Number.isFinite(measured.cpuRenderP95Ms)).toBe(true);
  } finally { await f.close(); }
});
