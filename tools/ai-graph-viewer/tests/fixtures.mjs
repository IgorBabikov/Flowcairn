import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';

export const token = 'fixture-control-token-1234567890';
export const hash = (value) => value.repeat(64);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
const objectHash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const denied = (reason = 'Ожидается подтверждение плана') => ({
  allowed: false,
  reason,
});
export const allowed = { allowed: true, reason: null };
export const allDenied = {
  run: denied(),
  retry: denied(),
  approve: denied(),
  accept: denied(),
  reject: denied(),
  recover: denied(),
  stop: denied(),
  requestReplan: denied(),
  openReceipt: denied(),
  rerunCheck: denied(),
};

export function graphNode(overrides = {}) {
  return {
    id: 'approve-plan',
    title: 'Проверка плана',
    outcome: 'Подтвердить scope и права',
    needs: [],
    action: { id: 'human-approve', kind: 'gate' },
    status: 'waiting-for-human',
    mode: 'read',
    permissions: [],
    skills: [
      {
        id: 'project-context',
        path: '.agents/skills/project-context/SKILL.md',
        hash: hash('1'),
      },
    ],
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    reason: null,
    receiptIds: [hash('b')],
    artifacts: [],
    changedFiles: [],
    checks: [],
    capabilities: {
      ...allDenied,
      approve: allowed,
      reject: allowed,
      requestReplan: allowed,
      openReceipt: allowed,
    },
    ...overrides,
  };
}

export const implementationNode = graphNode({
  id: 'implement',
  title: 'Implementation',
  outcome: 'Изменить разрешенные файлы',
  needs: ['approve-plan'],
  action: { id: 'ai-implement', kind: 'ai' },
  status: 'ready',
  mode: 'write',
  permissions: ['workspace.source.write'],
  attempt: 0,
  receiptIds: [],
  capabilities: { ...allDenied, requestReplan: allowed },
});

export function snapshot() {
  return {
    schemaVersion: 2,
    runId: 'run-demo',
    task: {
      id: 'TASK-101',
      taskNumber: 'FORM-101',
      goal: 'Собрать надежный Graph',
      scope: ['tools/ai-graph-viewer'],
      acceptance: ['UI следует backend capabilities'],
    },
    planVersion: 1,
    planHash: objectHash(plan),
    revision: 3,
    status: 'waiting-for-human',
    finalDisposition: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:01:00.000Z',
    nodes: [graphNode(), implementationNode],
    edges: [
      {
        id: 'approve-plan--implement',
        source: 'approve-plan',
        target: 'implement',
      },
    ],
    activeNodeId: null,
    gates: [
      {
        nodeId: 'approve-plan',
        type: 'approve-plan',
        title: 'Проверка плана',
        scope: ['tools/ai-graph-viewer'],
        planHash: objectHash(plan),
        requiredPermissions: ['workspace.source.write'],
        risks: ['AI может ошибаться'],
        evidence: [hash('c')],
        consequences: {
          approve: 'Разрешить immutable plan',
          reject: 'Закрыть run',
        },
        challenge: 'challenge-fixture',
        expiresAt: Date.now() + 300_000,
      },
    ],
    capabilities: {
      ...allDenied,
      approve: allowed,
      reject: allowed,
      requestReplan: allowed,
    },
    integrity: { valid: true, reason: null },
    runner: {
      ai: { available: true, reason: '' },
      checks: { available: true, reason: '' },
    },
    planningArtifacts: [
      {
        id: hash('c'),
        kind: 'plan',
        title: 'Plan evidence',
        mediaType: 'text/plain',
        size: 32,
      },
    ],
    supersedesRunId: null,
  };
}

export const plan = {
  schemaVersion: 2,
  taskHash: hash('d'),
  version: 1,
  parentPlanHash: null,
  sourceHash: hash('e'),
  runtimeHash: hash('f'),
  registryHash: hash('1'),
  policyHash: hash('2'),
  skills: [],
  nodes: [
    {
      id: 'approve-plan',
      title: 'Проверка плана',
      outcome: 'Подтвердить scope и права',
      needs: [],
      action: { id: 'human-approve', version: 1, inputs: {} },
      success: { kind: 'gate', requiredArtifacts: [] },
      permissions: [],
      skills: [],
      resources: { reads: [], writes: [], exclusive: [] },
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: 'implement',
      title: 'Implementation',
      outcome: 'Изменить разрешенные файлы',
      needs: ['approve-plan'],
      action: { id: 'ai-implement', version: 1, inputs: {} },
      success: { kind: 'implementation', requiredArtifacts: ['diff'] },
      permissions: ['workspace.source.write'],
      skills: [],
      resources: {
        reads: ['tools/ai-graph-viewer'],
        writes: ['tools/ai-graph-viewer/src'],
        exclusive: [],
      },
      retry: { maxAttempts: 2, backoffMs: 0 },
    },
  ],
};

function planForVersion(version) {
  return version === plan.version ? plan : { ...plan, version, parentPlanHash: objectHash(plan) };
}

export function runSummary(value) {
  return {
    runId: value.runId,
    task: value.task ?? null,
    status: value.status,
    revision: value.revision ?? null,
    planVersion: value.planVersion ?? null,
    planHash: value.planHash ?? null,
    updatedAt: value.updatedAt ?? null,
    integrity: value.integrity,
  };
}

// Explicit browser fixture. No planner or external AI is called by these tests.
export const projectContext = {
  schemaVersion: 2, name: 'Тестовый проект', contextHash: hash('a'),
  contextPaths: ['AGENTS.md', 'src/search.ts'], scopeCandidates: ['src'], checks: ['tests'],
  ai: { provider: 'fixture', model: 'no-external-ai' },
  capabilities: { intake: allowed },
};

export async function mockApi(page, initial = snapshot(), options = {}) {
  let current = structuredClone(initial);
  const calls = [];
  let heldSnapshot = null;
  let runAttempts = 0;
  let stopAttempts = 0;
  let createAttempts = 0;
  let intakeCreated = false;
  let snapshotReads = 0;
  let listReads = 0;
  let activeSnapshotReads = 0;
  let maxSnapshotReads = 0;
  const holdNextSnapshot = () => {
    let capturedResolve;
    let releaseResolve;
    const captured = new Promise((resolve) => {
      capturedResolve = resolve;
    });
    const released = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    heldSnapshot = {
      capture: capturedResolve,
      released,
    };
    return { captured, release: releaseResolve };
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    expect(request.headers()['x-flowcairn-control']).toBe(token);
    const url = new URL(request.url());
    if (url.pathname === '/api/onboarding') {
      await route.fulfill({json: {configured:true, profileHash:hash('a'), providers:[{id:'codex',label:'Codex',supported:true,state:'available',reason:null},{id:'claude',label:'Claude Code',supported:true,state:'available',reason:null},{id:'cursor',label:'Cursor',supported:true,state:'available',reason:null}], values:{provider:'codex',model:'gpt-test',modelMode:'manual',reasoningEffort:'high',testPolicy:'keep',coverage:false,checkMode:'trusted-local',checks:['tests'],readConsent:true}, limitations:[]}}); return;
    }
    if (url.pathname === '/api/project') {
      if (options.projectDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.projectDelayMs));
      await route.fulfill({ json: options.projectContext ?? projectContext }); return;
    }
    if (url.pathname.endsWith('/stream')) {
      if (options.streamBurst?.length) {
        current = { ...current, revision: Math.max(...options.streamBurst) };
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: (options.streamBurst ?? [current.revision ?? 0])
          .map((revision) => `event: revision\ndata: {"revision":${revision}}\n\n`)
          .join(''),
      });
      return;
    }
    if (url.pathname === '/api/intake/preview' && request.method() === 'POST') {
      const body = request.postDataJSON();
      calls.push({ action: 'preview', body });
      const context = options.projectContext ?? projectContext;
      await route.fulfill({ json: { contextHash: context.contextHash, previewHash: hash('e'),
        scope: body.selection?.scope ?? ['src'], candidates: context.scopeCandidates,
        references: [], issues: [], feedback: [], ready: true } });
      return;
    }
    if (url.pathname === '/api/intake' && request.method() === 'POST') {
      const body = request.postDataJSON();
      calls.push({ action: 'intake', body });
      createAttempts += 1;
      if (options.intakeError) { await route.fulfill({ status: 409, json: {error: options.intakeError} }); return; }
      current = {
        ...current, runId: 'run-intake-fixture', revision: 0, phase: 'planning',
        task: { id: 'TASK-GENERATED', goal: body.title, title: body.title, description: body.description, taskNumber: body.taskNumber, scope: ['src'], acceptance: [] },
      };
      intakeCreated = true;
      if (options.loseFirstCreateResponse && createAttempts === 1) {
        await route.abort('connectionreset'); return;
      }
      await route.fulfill({ status: 201, json: { result: current } }); return;
    }
    if (url.pathname === '/api/runs' && request.method() === 'GET') {
      listReads += 1;
      if (options.listDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
      await route.fulfill({
        json: {
          runs:
            (options.emptyFirstList && listReads === 1) || (options.emptyUntilIntake && !intakeCreated)
              ? []
              : [runSummary(current), ...(options.extraRuns ?? [])],
          capabilities: { create: allowed },
        },
      });
      return;
    }
    if (url.pathname.endsWith('/snapshot')) {
      snapshotReads += 1;
      activeSnapshotReads += 1;
      maxSnapshotReads = Math.max(maxSnapshotReads, activeSnapshotReads);
      try {
        if (options.advanceAfterFirstSnapshot && snapshotReads > 1) {
          current = { ...current, revision: Math.max(current.revision ?? 0, 4) };
        }
        const response =
          options.failClosedSnapshotAfterFirst && snapshotReads > 1
            ? {
                schemaVersion: 2,
                runId: current.runId,
                status: 'stale',
                nodes: [],
                edges: [],
                gates: [],
                capabilities: allDenied,
                integrity: { valid: false, reason: 'Integrity не подтверждена' },
              }
            : structuredClone(current);
        if (heldSnapshot) {
          const held = heldSnapshot;
          heldSnapshot = null;
          held.capture();
          await held.released;
        }
        const delay =
          snapshotReads > 1
            ? (options.snapshotDelayAfterFirstMs ?? options.snapshotDelayMs)
            : options.snapshotDelayMs;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return route.fulfill({ json: response });
      } finally {
        activeSnapshotReads -= 1;
      }
    }
    if (url.pathname.endsWith('/plan')) {
      const runId = decodeURIComponent(url.pathname.split('/').at(-2));
      const configured = options.planResponses?.[runId];
      if (configured?.delayMs)
        await new Promise((resolve) => setTimeout(resolve, configured.delayMs));
      return route.fulfill({
        json: configured?.plan ?? planForVersion(current.planVersion ?? plan.version),
      });
    }
    if (url.pathname.endsWith('/events')) {
      if (options.eventsDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.eventsDelayMs));
      return route.fulfill({
        json: {
          events: [
            {
              runId: current.runId,
              revision: current.revision ?? 0,
              at: current.updatedAt ?? '',
              status: current.status,
              planHash: current.planHash ?? hash('0'),
              nodes: current.nodes.map((item) => ({
                id: item.id,
                status: item.status,
                attempt: item.attempt,
                receiptIds: item.receiptIds,
              })),
            },
          ],
        },
      });
    }
    if (url.pathname.includes('/receipts/')) {
      return route.fulfill({
        json: {
          schemaVersion: 2,
          runId: current.runId,
          nodeId: 'approve-plan',
          attemptId: 'attempt-one',
          attempt: 1,
          phase: 'gate',
          actionId: 'human-approve',
          actionVersion: 1,
          planVersion: 1,
          planHash: current.planHash,
          taskHash: hash('d'),
          sourceHash: hash('e'),
          runtimeHash: hash('f'),
          instructionsHash: hash('1'),
          skills: [],
          permissions: [],
          grantedPermissions: ['workspace.source.write'],
          termination: null,
          startedAt: current.createdAt,
          finishedAt: current.updatedAt,
          durationMs: 10,
          exitCode: 0,
          verdict: 'pass',
          checks: [],
          artifacts: [],
          changedFiles: [],
          failureReason: null,
          beforeFingerprint: hash('2'),
          afterFingerprint: hash('2'),
          actor: 'local-operator',
          operationId: 'gate-one',
          previousReceipt: null,
        },
      });
    }
    if (url.pathname.includes('/artifacts/')) {
      return route.fulfill({
        json: {
          schemaVersion: 2,
          id: hash('c'),
          kind: 'plan',
          title: 'Plan evidence',
          mediaType: 'text/plain',
          content: '<script>attack()</script>',
        },
      });
    }
    if (url.pathname.endsWith('/control/revise-plan')) {
      const body = request.postDataJSON();
      calls.push({action:'revise-plan',body});
      const parent = current.runId;
      current = {...current,runId:'run-revised',supersedesRunId:parent,revision:0,planVersion:2,planHash:objectHash(planForVersion(2))};
      current.gates = current.gates.map(gate => ({...gate,planHash:current.planHash,challenge:'revised-challenge'}));
      await route.fulfill({json:{result:current}}); return;
    }
    if (url.pathname.endsWith('/control/gate')) {
      const body = request.postDataJSON();
      calls.push({ action: 'gate', body });
      if (options.gateErrorCode) {
        await route.fulfill({
          status: 400,
          json: {
            error: {
              code: options.gateErrorCode,
              message: 'Gate challenge expired',
            },
          },
        });
        return;
      }
      current = {
        ...current,
        revision: current.revision + 1,
        status: 'ready',
        gates: [],
        nodes: [
          graphNode({ status: 'passed', capabilities: allDenied }),
          {
            ...implementationNode,
            capabilities: {
              ...allDenied,
              run: allowed,
              requestReplan: allowed,
            },
          },
        ],
        capabilities: { ...allDenied, run: allowed, requestReplan: allowed },
      };
      await route.fulfill({ json: { result: current } });
      return;
    }
    if (url.pathname.endsWith('/control/run')) {
      const body = request.postDataJSON();
      calls.push({ action: 'run', body });
      runAttempts += 1;
      let response;
      if (options.exposeRunningBeforeRunResponse) {
        current = {
          ...current,
          revision: current.revision + 1,
          status: 'running',
          capabilities: { ...allDenied, stop: allowed },
        };
        response = structuredClone(current);
      }
      if (options.runDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.runDelayMs));
      if (options.loseFirstRunResponse !== false && runAttempts === 1) {
        await route.abort('connectionreset');
        return;
      }
      if (!response) {
        current = {
          ...current,
          revision: current.revision + 1,
          status: 'running',
          capabilities: { ...allDenied, stop: allowed },
        };
        response = structuredClone(current);
      }
      await route.fulfill({ json: { result: response } });
      return;
    }
    if (url.pathname.endsWith('/control/stop')) {
      const body = request.postDataJSON();
      calls.push({ action: 'stop', body });
      stopAttempts += 1;
      if (options.stopConflictFirst && stopAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'REVISION_CONFLICT',
              message: 'Revision изменилась',
            },
          },
        });
        return;
      }
      current = {
        ...current,
        revision: current.revision + 1,
        status: 'uncertain',
        execution: {
          state: options.stopResponseState ?? 'stopping',
          stopRequested: true,
        },
        capabilities: allDenied,
      };
      if (options.stopDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.stopDelayMs));
      if (options.loseStopResponse) {
        await route.abort('connectionreset');
        return;
      }
      await route.fulfill({ json: { result: current } });
      return;
    }
    if (url.pathname.endsWith('/control/replan') || url.pathname.endsWith('/control/recover')) {
      const action = url.pathname.endsWith('/control/replan') ? 'replan' : 'recover';
      const body = request.postDataJSON();
      calls.push({ action, body });
      const previousRunId = current.runId;
      const planVersion = (current.planVersion ?? 1) + 1;
      current = {
        ...current,
        runId: `${previousRunId}-successor`,
        supersedesRunId: previousRunId,
        phase: current.phase === 'planning' ? 'execution' : current.phase,
        planVersion,
        planHash: objectHash(planForVersion(planVersion)),
        revision: 0,
        status: 'waiting-for-human',
      };
      await route.fulfill({ json: { result: current } });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'not found' } },
    });
  });
  return {
    calls,
    current: () => current,
    holdNextSnapshot,
    snapshotReads: () => snapshotReads,
    maxSnapshotReads: () => maxSnapshotReads,
    listReads: () => listReads,
  };
}
