import { expect, test } from '@playwright/test';
import { allDenied, hash, mockApi, snapshot, token } from './fixtures.mjs';

// Synthetic browser data: runtime semantics are covered by task-proof integration tests.
function taskWithProof() {
  const state = snapshot();
  state.workflow = 'autonomous'; state.phase = 'execution'; state.status = 'passed'; state.completion = 'ready-for-review';
  state.gates = []; state.capabilities = allDenied; state.task.title = 'Надежная форма заявки';
  state.nodes = state.nodes.map(node => ({ ...node, status: 'passed', capabilities: allDenied }));
  state.nodes[1].changedFiles = ['src/request-form.ts'];
  const requirement = { id: 'R1', title: 'Форма отклоняет пустой адрес', mandatory: true, origin: 'acceptance',
    verification: { method: 'check', checkIds: ['form-validation'], criterion: 'Пустое поле не отправляет заявку', paths: ['src/request-form.ts'] }, workIds: ['implement'] };
  const evidence = { id: 'E1', requirementIds: ['R1'], nodeId: 'implement', runId: state.runId, receiptId: hash('b'), artifactIds: [hash('c')],
    method: 'check', summary: 'Сценарий отправки с пустым адресом выполнен: показана ошибка, заявка не отправлена.', status: 'passed', freshness: 'current',
    checkedAt: '2026-09-17T11:00:00.000Z', resultHash: hash('a'), staleReason: null };
  state.proof = {
    resultHash: hash('a'), acceptance: { allowed: false, reason: null, challenge: null },
    contract: { version: 1, goal: 'Создать форму заявки с проверкой обязательных полей.', instructionsHash: hash('2'), requirements: [requirement], optionalImprovements: [], constraints: ['Не отправлять данные во внешние сервисы'], assumptions: [], unknowns: [], scope: ['src'], forbiddenPaths: [], rigor: { level: 'standard', reasons: ['Пользовательские данные требуют проверки валидации'] } },
    requirements: [{ ...requirement, status: 'proven', reason: 'Проверка прошла для текущего результата.', workNodeIds: ['implement'], artifactIds: [hash('c')], evidenceIds: ['E1'], findingIds: [] }],
    evidence: [evidence], findings: [], coverage: { required: 1, proven: 1 }, status: 'PROVEN', blockers: [],
    certificate: { version: 1, id: 'certificate-1', taskId: state.task.id, goal: state.task.goal, contractHash: hash('2'), resultHash: hash('a'), requirementIds: ['R1'], evidenceIds: ['E1'], receiptIds: [hash('b')], issuedAt: '2026-09-17T11:00:00.000Z' },
    usage: { aiCalls: 3, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, tokensPerProvenRequirement: null, costPerProvenRequirement: null, reportedCalls: 0, unknownCalls: 3, contextBytes: 2350, durationMs: 3000, repairCalls: 1, verificationCalls: 1, byRequirement: [{ requirementId: 'R1', aiCalls: 2, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }] },
  };
  return state;
}

test('task cockpit leads to requirement evidence and advanced graph', async ({ page }) => {
  await mockApi(page, taskWithProof()); await page.goto(`/#session=${token}`);
  await expect(page.getByRole('region', { name: 'Задача и доказательства' })).toBeVisible();
  await expect(page.locator('.detail-panel')).toHaveCount(0);
  await expect(page.locator('.detail-scroll')).toHaveCount(0);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
  await expect(page.getByText('PROVEN', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('requirement-coverage')).toContainText('1 из 1');
  await expect(page.locator('.graph-region')).toHaveCount(0);
  await expect(page.getByText('Отчет о выполнении', { exact: true })).toBeVisible();
  const requirement = page.getByRole('region', { name: 'Доказательство требования', exact: true });
  await expect(requirement).toContainText('Пустое поле не отправляет заявку');
  await expect(requirement).toContainText('Актуально');
  const receipt = page.waitForRequest(request => request.url().includes(`/api/runs/run-demo/receipts/${hash('b')}`));
  await requirement.getByRole('button', { name: 'Открыть отчет проверки' }).click(); await receipt;
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await requirement.getByRole('button', { name: 'Результат 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('<script>attack()</script>');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Граф', exact: true }).click();
  await page.getByRole('button', { name: 'Детали исполнения', exact: true }).click();
  await expect(page.locator('.graph-node').first()).toBeVisible();
  await expect(page.locator('.detail-panel')).toHaveCount(1);
  await expect(page.locator('.detail-scroll')).toHaveCount(1);
  await page.getByRole('button', { name: 'Задача', exact: true }).click();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
});

test('execution failure with proof shows the real runtime cause above requirement gaps', async ({ page }) => {
  const state = taskWithProof();
  state.status = 'failed';
  state.nodes[1] = { ...state.nodes[1], status: 'failed', reason: 'NON_ZERO_EXIT' };
  state.proof.status = 'BLOCKED';
  state.proof.certificate = null;
  state.proof.coverage.proven = 0;
  state.proof.requirements[0].status = 'blocked';
  state.proof.blockers = ['Исполнение находится в состоянии failed'];
  await mockApi(page, state);
  await page.goto(`/#session=${token}`);
  await expect(page.getByTestId('task-proof-status')).toHaveText('AI-исполнитель завершился с ошибкой');
  await expect(page.locator('.task-cockpit .workflow-problem')).toContainText('ненулевым кодом');
  await expect(page.locator('.task-cockpit .workflow-problem .technical-details')).not.toHaveAttribute('open', '');
});

test('mobile run rail opens as a modal and restores focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, taskWithProof());
  await page.goto(`/#session=${token}`);

  const opener = page.getByRole('button', { name: 'Показать запуски', exact: true });
  await expect(opener).toBeVisible();
  await expect(page.locator('.desktop-run-rail')).toBeHidden();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Запуски', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-runs-drawer.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('mobile run modal closes when viewport becomes desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, taskWithProof());
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Показать запуски', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Запуски', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1366, height: 768 });

  await expect(page.locator('dialog.mobile-runs-dialog')).toHaveCount(0);
  await expect(page.locator('.desktop-run-rail')).toBeVisible();
});

test('compact graph details open as a closable dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await mockApi(page, taskWithProof());
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Граф', exact: true }).click();
  await page.getByRole('button', { name: 'Детали исполнения', exact: true }).click();

  const details = page.getByRole('dialog', { name: 'Детали исполнения', exact: true });
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Закрыть детали', exact: true }).click();
  await expect(details).toHaveCount(0);
});

test('reports and English navigation use readable labels while API status stays unchanged', async ({ page }) => {
  const state = taskWithProof();
  const fixture = await mockApi(page, state); await page.goto(`/#session=${token}`);
  await page.getByRole('region', { name: 'Доказательство требования', exact: true }).getByRole('button', { name: 'Открыть отчет проверки' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /^Отчет проверки / })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const legacy = fixture.current(); legacy.workflow = null; legacy.revision += 1;
  await page.getByRole('button', { name: 'На английском', exact: true }).click();
  await expect(page.locator('.run-row em')).toHaveText('Result confirmed');
  await page.getByRole('button', { name: 'Граф', exact: true }).click();
  await page.getByRole('button', { name: 'Детали исполнения', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Check results', exact: true })).toBeVisible();
  expect(state.proof.status).toBe('PROVEN');
});

test('stale evidence revokes visible completion after a committed revision', async ({ page }) => {
  const fixture = await mockApi(page, taskWithProof()); await page.goto(`/#session=${token}`);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
  const current = fixture.current(); current.revision += 1; current.proof.status = 'STALE'; current.proof.coverage.proven = 0;
  current.proof.requirements[0].status = 'stale'; current.proof.requirements[0].reason = 'После проверки изменена форма.';
  current.proof.evidence[0].freshness = 'stale'; current.proof.evidence[0].staleReason = 'Исходные файлы изменились после проверки.'; current.proof.certificate = null;
  await expect(page.getByTestId('task-proof-status')).toHaveText('Нужна повторная проверка');
  await expect(page.getByText('Отчет о выполнении', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Доказательство требования', exact: true })).toContainText('Исходные файлы изменились после проверки.');
  await expect(page.getByRole('heading', { name: 'Готово к вашему ревью', exact: true })).toHaveCount(0);
});

test('stale blockers name the check and requirement for a person', async ({ page }) => {
  const state = taskWithProof();
  state.proof.status = 'STALE'; state.proof.coverage.proven = 0; state.proof.certificate = null;
  state.proof.requirements[0].status = 'stale';
  state.proof.blockers = [
    'Обязательная проверка check-tests не подтверждена на текущем результате',
    'R1: Нужна актуальная успешная проверка требования',
  ];
  await mockApi(page, state); await page.goto(`/#session=${token}`);
  const blockers = page.locator('.proof-blockers');
  await expect(blockers).toContainText('Тесты нужно повторить для текущего состояния файлов.');
  await expect(blockers).toContainText('Форма отклоняет пустой адрес: Нужна актуальная успешная проверка требования');
  await expect(blockers).not.toContainText('check-tests');
  await expect(blockers).not.toContainText('R1:');
});

test('a failed live snapshot hides previous proof until fresh confirmation returns', async ({ page }) => {
  await mockApi(page, taskWithProof()); await page.goto(`/#session=${token}`);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
  await page.route('**/snapshot', route => route.fulfill({ status: 500, json: { error: { code: 'INTEGRITY', message: 'Evidence lineage is unavailable' } } }));
  await expect(page.getByRole('heading', { name: 'Актуальность результата не подтверждена' })).toBeVisible();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(page.locator('.completion-certificate')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Готово к вашему ревью' })).toHaveCount(0);
  await expect(page.locator('.run-row em')).toHaveText('Состояние недоступно');
  await page.unroute('**/snapshot');
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
});

test('workflow check summary loses its green pass when proof becomes stale or unavailable', async ({ page }) => {
  const state = taskWithProof();
  state.nodes[1].receiptIds = [hash('b')];
  state.nodes[1].checks = [{ id: 'form-validation', passed: true, exitCode: 0, durationMs: 10, summary: 'Проверено', inputHash: hash('a') }];
  const fixture = await mockApi(page, state); await page.goto(`/#session=${token}`);
  const evidence = page.getByRole('region', { name: 'Доказательство требования', exact: true });
  await expect(evidence).toContainText('Проверка пройдена');
  await expect(evidence).toContainText('Актуально');
  const current = fixture.current(); current.revision += 1; current.proof.resultHash = hash('c');
  current.proof.status = 'STALE'; current.proof.certificate = null; current.proof.evidence[0].freshness = 'stale';
  current.proof.evidence[0].staleReason = 'Проверенное состояние изменилось.';
  await expect(evidence).toContainText('Устарело');
  await expect(evidence).toContainText('Проверенное состояние изменилось.');
  await page.route('**/snapshot', route => route.fulfill({ status: 500, json: { error: { code: 'INTEGRITY', message: 'State unavailable' } } }));
  await expect(page.getByRole('heading', { name: 'Актуальность результата не подтверждена' })).toBeVisible();
  await expect(page.getByText('Проверка пройдена', { exact: true })).toHaveCount(0);
});

test('incomplete coverage and unavailable verification are never completion', async ({ page }) => {
  const state = taskWithProof(); state.proof.status = 'UNPROVEN'; state.proof.coverage.required = 2; state.proof.certificate = null;
  state.proof.requirements.push({ ...state.proof.requirements[0], id: 'R2', title: 'Письмо доставляется получателю', status: 'unproven', reason: 'Проверка доставки недоступна.', evidenceIds: [], verification: { method: 'human', checkIds: [], criterion: 'Получатель подтвердил получение письма', paths: [] } });
  state.proof.blockers = ['Требование «Письмо доставляется получателю» еще не доказано.'];
  await mockApi(page, state); await page.goto(`/#session=${token}`);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Результат пока не подтвержден');
  await expect(page.getByTestId('requirement-coverage')).toContainText('1 из 2');
  await expect(page.getByRole('region', { name: 'Доказательство требования', exact: true })).toContainText('Проверка доставки недоступна.');
  await expect(page.locator('.completion-certificate')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Подтверждаю выполнение требования' })).toHaveCount(0);
});

test('human acceptance binds the explicit decision to revision and result', async ({ page }) => {
  const state = taskWithProof(); state.proof.status = 'UNPROVEN'; state.proof.certificate = null; state.proof.coverage.proven = 0;
  state.proof.requirements[0].status = 'unproven'; state.proof.requirements[0].verification.method = 'human';
  state.proof.requirements[0].evidenceIds = []; state.proof.evidence = [];
  state.nodes[1].artifacts = [{ id: hash('c'), title: 'Результат для личной приемки', kind: 'implementation', mediaType: 'text/plain', size: 32 }];
  state.proof.acceptance = { allowed: true, reason: null, challenge: 'accept-current-result' };
  const fixture = await mockApi(page, state); let request;
  await page.route('**/control/verify-requirement', async route => { request = route.request().postDataJSON(); const next = fixture.current(); next.revision += 1; next.proof.acceptance.allowed = false; await route.fulfill({ json: { result: next } }); });
  await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Результат для личной приемки', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const accept = page.getByRole('button', { name: 'Подтверждаю выполнение требования' });
  await expect(accept).toBeDisabled();
  await page.getByLabel('Что вы проверили и чем подтверждается результат?').fill('Открыл форму: пустой адрес блокирует отправку и показывает ошибку.');
  await accept.click();
  await expect.poll(() => request).toMatchObject({ requirementId: 'R1', expectedRevision: 3, resultHash: hash('a'), challenge: 'accept-current-result', decision: 'accept' });
  expect(request.reason).toContain('пустой адрес');
  await expect(accept).toHaveCount(0);
});

test('resource gaps stay unknown and findings explain repair', async ({ page }) => {
  const state = taskWithProof(); state.proof.findings = [{ id: 'F1', title: 'Ошибка валидации найдена и исправлена', status: 'resolved', blocking: true, requirementIds: ['R1'], repairNodeIds: ['implement'] }];
  await mockApi(page, state); await page.goto(`/#session=${token}`);
  await page.getByRole('button', { name: 'Ресурсы', exact: true }).click();
  const resources = page.getByRole('region', { name: 'Расход ресурсов' });
  await expect(resources).toContainText('Нет данных');
  await expect(resources).toContainText('Без полного отчета: 3');
  await expect(resources.locator('dt', { hasText: 'Все токены' }).locator('+ dd')).toHaveText('Нет данных');
  await page.getByRole('button', { name: 'Изменения', exact: true }).click();
  await expect(page.locator('.proof-changes')).toContainText('src/request-form.ts');
  await expect(page.locator('.proof-changes')).toContainText('Исправлено и перепроверено');
});

test('planning without a contract stays readable and source review cannot be accepted as human evidence', async ({ page }) => {
  const state = taskWithProof(); state.proof.status = 'BLOCKED'; state.proof.certificate = null; state.proof.contract = null;
  state.proof.requirements = []; state.proof.evidence = []; state.proof.coverage = { required: 0, proven: 0 };
  state.proof.blockers = ['Контракт требований еще не сформирован']; state.proof.usage.contextBytes = null;
  const fixture = await mockApi(page, state); await page.goto(`/#session=${token}`);
  await expect(page.getByRole('region', { name: 'Задача и доказательства' })).toContainText('Требования еще не сформированы');
  const next = fixture.current(); next.revision += 1; next.proof.requirements = taskWithProof().proof.requirements;
  next.proof.requirements[0].status = 'unproven'; next.proof.requirements[0].verification.method = 'source-review';
  next.proof.acceptance = { allowed: true, reason: null, challenge: 'human-only' };
  await expect(page.getByRole('region', { name: 'Доказательство требования', exact: true })).toContainText('Проверка исходных данных');
  await expect(page.getByRole('button', { name: 'Подтверждаю выполнение требования' })).toHaveCount(0);
});

test('cockpit remains readable on desktop and mobile', async ({ page }, testInfo) => {
  await mockApi(page, taskWithProof());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height }); await page.goto(`/#session=${token}`);
    await expect(page.getByTestId('task-proof-status')).toHaveText('Результат подтвержден');
    await page.screenshot({ path: testInfo.outputPath(`cockpit-${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed';
    }).map(element => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width })).slice(0, 8));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow)).toBe(true);
  }
});
