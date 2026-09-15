import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectProcess, probeRunner, runRegisteredAction } from './lib/runner.mjs';
import { buildPrompt } from './lib/codex.mjs';
import { AIResultSchema } from './lib/schemas.mjs';
import { classifyAiFailure } from './lib/supervisor.mjs';

const NODE_BINARY = realpathSync(process.execPath);
const SUPERVISOR_FILE = fileURLToPath(new URL('./lib/supervisor.mjs', import.meta.url));
const fixtures = new Set();

function runnerContract() {
  const task = {
    schemaVersion: 2,
    id: 'RUNNER-TEST',
    goal: 'Проверить runner boundary',
    instructions: 'Запустить только registered check.',
    scope: ['scripts/ai-graph'],
    contextPaths: [],
    forbiddenPaths: [],
    includeUntracked: [],
    acceptance: ['Runner отклоняет unsafe allocation.'],
    checks: ['graph-tests'],
    resources: [],
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5_000 },
    sourceHash: 'a'.repeat(64),
  };
  const node = {
    id: 'check-graph',
    title: 'Graph tests',
    outcome: 'Graph tests выполнены.',
    needs: [],
    action: { id: 'check-graph-tests', version: 1, inputs: {} },
    success: { kind: 'checks', requiredArtifacts: ['test-report'] },
    permissions: ['workspace.output.write'],
    skills: [],
    resources: { reads: ['scripts/ai-graph'], writes: [], exclusive: [] },
    retry: { maxAttempts: 1, backoffMs: 0 },
  };
  const gate = {
    ...node,
    id: 'accept-result',
    title: 'Accept result',
    outcome: 'Результат принят.',
    action: { id: 'human-accept', version: 1, inputs: {} },
    success: { kind: 'gate', requiredArtifacts: [] },
    permissions: [],
    resources: { reads: [], writes: [], exclusive: [] },
  };
  return {
    task,
    node,
    plan: {
      schemaVersion: 2,
      taskHash: sha256(canonicalJson(task)),
      version: 1,
      parentPlanHash: null,
      sourceHash: task.sourceHash,
      runtimeHash: 'b'.repeat(64),
      registryHash: 'c'.repeat(64),
      policyHash: 'd'.repeat(64),
      skills: [],
      nodes: [node, gate],
    },
  };
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-runner-test-'));
  chmodSync(directory, 0o700);
  fixtures.add(directory);
  return directory;
}

test.after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function supervisorFixture({
  command,
  timeoutMs = 5_000,
  maxOutputBytes = 8_192,
  actionId = 'check-graph-tests',
}) {
  const directory = fixture();
  const ticket = path.join(directory, 'ticket.json');
  const nonce = randomBytes(32).toString('hex');
  const initial = {
    version: 1,
    state: 'reserved',
    actionId,
    createdAt: new Date().toISOString(),
    nonceHash: sha256(nonce),
    commandHash: sha256(canonicalJson(command)),
    timeoutMs,
    maxOutputBytes,
  };
  writeFileSync(ticket, `${JSON.stringify(initial)}\n`, { mode: 0o600, flag: 'wx' });
  const child = spawn(NODE_BINARY, [SUPERVISOR_FILE, ticket], {
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const values = [];
  const waiters = [];
  child.stdio[3].on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.find((candidate) => candidate.type === value.type);
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(value);
      } else {
        values.push(value);
      }
    }
  });
  const next = (type) => {
    const index = values.findIndex((value) => value.type === type);
    if (index >= 0) return Promise.resolve(values.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((candidate) => candidate.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 8_000);
      waiters.push({
        type,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  };
  return { child, command, directory, initial, next, nonce, ticket };
}

async function closeSupervisor(subject) {
  subject.child.stdin.destroy();
  if (subject.child.exitCode === null && subject.child.signalCode === null) {
    await once(subject.child, 'close');
  }
}

test('supervisor does not start an action before the durable GO acknowledgement', async () => {
  const directory = fixture();
  const marker = path.join(directory, 'started');
  const command = {
    executable: NODE_BINARY,
    args: ['-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  };
  const subject = supervisorFixture({ command });
  const ready = await subject.next('ready');
  assert.equal(ready.pid, subject.child.pid);
  assert.equal(existsSync(marker), false);

  subject.child.stdin.write(
    `${JSON.stringify({ type: 'go', nonce: subject.nonce, command, input: '' })}\n`,
  );
  const final = await subject.next('finished');
  assert.equal(final.exitCode, 0);
  assert.equal(final.failureReason, null);
  assert.equal(existsSync(marker), true);
  await closeSupervisor(subject);
  assert.equal(JSON.parse(readFileSync(subject.ticket, 'utf8')).state, 'finished');
});

test('supervisor rejects a forged GO without starting the action', async () => {
  const directory = fixture();
  const marker = path.join(directory, 'started');
  const command = {
    executable: NODE_BINARY,
    args: ['-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  };
  const subject = supervisorFixture({ command });
  await subject.next('ready');
  subject.child.stdin.write(
    `${JSON.stringify({ type: 'go', nonce: 'forged', command, input: '' })}\n`,
  );
  const final = await subject.next('finished');
  assert.equal(final.failureReason, 'CONTROL_REJECTED');
  assert.equal(existsSync(marker), false);
  await closeSupervisor(subject);
});

test('supervisor records parent disconnect before GO without starting the action', async () => {
  const directory = fixture();
  const marker = path.join(directory, 'started');
  const command = {
    executable: NODE_BINARY,
    args: ['-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  };
  const subject = supervisorFixture({ command });
  await subject.next('ready');
  subject.child.stdin.end();
  const final = await subject.next('finished');
  assert.equal(final.failureReason, 'START_NOT_ACKNOWLEDGED');
  assert.equal(existsSync(marker), false);
  await closeSupervisor(subject);
});

test('supervisor records timeout and stops the owned process group', async () => {
  const directory = fixture();
  const command = {
    executable: NODE_BINARY,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  };
  const subject = supervisorFixture({ command, timeoutMs: 1_000 });
  await subject.next('ready');
  subject.child.stdin.write(
    `${JSON.stringify({ type: 'go', nonce: subject.nonce, command, input: '' })}\n`,
  );
  const final = await subject.next('finished');
  assert.equal(final.failureReason, 'TIMEOUT');
  await closeSupervisor(subject);
  assert.throws(() => process.kill(-subject.child.pid, 0), { code: 'ESRCH' });
});

test('supervisor bounds process output and records the forced stop', async () => {
  const directory = fixture();
  const command = {
    executable: NODE_BINARY,
    args: ['-e', "process.stdout.write('x'.repeat(4096));setInterval(() => {}, 1000)"],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  };
  const subject = supervisorFixture({ command, maxOutputBytes: 1_024 });
  await subject.next('ready');
  subject.child.stdin.write(
    `${JSON.stringify({ type: 'go', nonce: subject.nonce, command, input: '' })}\n`,
  );
  const final = await subject.next('finished');
  assert.equal(final.failureReason, 'OUTPUT_LIMIT');
  assert.ok(final.stdoutBytes > 1_024);
  await closeSupervisor(subject);
  assert.throws(() => process.kill(-subject.child.pid, 0), { code: 'ESRCH' });
});

test('public runner validates registry identity before touching runtime paths', async () => {
  await assert.rejects(
    // @ts-expect-error The partial input proves registry validation precedes path access.
    runRegisteredAction({
      root: '/path/that/must/not/be-read',
      node: { action: { id: 'shell', version: 1, inputs: {} } },
    }),
    { code: 'UNKNOWN_ACTION' },
  );
});

test('system temporary directories fail closed for execution, recovery, and probing', async () => {
  const contract = runnerContract();
  const systemTemp = realpathSync(fixture());
  writeFileSync(
    path.join(systemTemp, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'main',
      packageManager: 'npm',
      contextPaths: [],
      checks: ['tests'],
      outputPaths: [],
      manifests: ['package.json', 'package-lock.json'],
      ai: { provider: 'codex', model: 'fixture-model' },
    }),
  );
  await assert.rejects(
    runRegisteredAction({
      root: systemTemp,
      worktree: systemTemp,
      outputDirectory: systemTemp,
      ...contract,
      skills: [],
      toolchain: null,
      signal: undefined,
      onStart() {},
    }),
    { code: 'RUNNER_TEMP_UNSAFE' },
  );
  assert.throws(
    () =>
      inspectProcess({
        root: systemTemp,
        process: {
          version: 1,
          ticket: '.ai-orchestrator/graph/runner-tickets/12345678-1234-4123-8123-123456789abc.json',
          supervisorPid: 999_999,
          pgid: 999_999,
          startedAt: new Date().toISOString(),
          nonceHash: 'a'.repeat(64),
          commandHash: 'b'.repeat(64),
          ticketHash: 'c'.repeat(64),
        },
      }),
    { code: 'RUNNER_TEMP_UNSAFE' },
  );
  const probe = await probeRunner({ root: systemTemp });
  assert.equal(probe.ai.available, false);
  assert.equal(probe.checks.available, false);
  assert.match(
    probe.checks.reason,
    process.platform === 'darwin'
      ? /SYSTEM_TEMP_UNSAFE|RUNNER_TEMP_UNSAFE/
      : /UNSUPPORTED_PLATFORM/,
  );
});

test('runner source does not pin a developer home directory', () => {
  const source = readFileSync(fileURLToPath(new URL('./lib/runner.mjs', import.meta.url)), 'utf8');
  assert.equal(source.includes('/Users/'), false);
  assert.equal(source.includes('/home/'), false);
});

test('AI actions are source read-only and the result contract carries bounded structured edits', () => {
  const source = readFileSync(fileURLToPath(new URL('./lib/runner.mjs', import.meta.url)), 'utf8');
  assert.match(source, /permissionFilesystem\(worktree, \[\], \{/);
  assert.doesNotMatch(source, /ai-implement[^\n]*node\.resources\.writes/);
  const edits = Array.from({ length: 8 }, (_, index) => ({
    path: `scripts/ai-graph/proposed-${index}.mjs`,
    previousHash: null,
    content: 'x'.repeat(128 * 1024),
    executable: false,
  }));
  const result = AIResultSchema.parse({
    summary: 'Предложены изменения без записи в source workspace.',
    verdict: 'pass',
    skillsUsed: [],
    findings: [],
    changedFiles: edits.map((edit) => edit.path),
    edits,
    plan: [],
  });
  assert.equal(result.edits.length, 8);
  const contract = runnerContract();
  const prompt = buildPrompt({
    nodeId: contract.node.id,
    task: contract.task,
    plan: contract.plan,
    skills: 'No assigned skills.',
    priorEvidence: null,
  });
  assert.match(prompt, /Объявленный read context: scripts\/ai-graph/);
  assert.match(prompt, /Зарегистрированные проверки запускает Executor/);
  assert.match(prompt, /Ты не записываешь файлы/);
  const analysisNode = {
    ...contract.node,
    id: 'analyze',
    action: { id: 'ai-analyze', version: 1, inputs: {} },
  };
  const analysisPrompt = buildPrompt({
    nodeId: analysisNode.id,
    task: contract.task,
    plan: { ...contract.plan, workflow: 'autonomous', nodes: [analysisNode] },
    skills: 'No assigned skills.',
    priorEvidence: null,
  });
  assert.match(analysisPrompt, /Неизвестный backend\/API-контракт/);
  assert.match(analysisPrompt, /ограничить такой план локальным UI/);
});

test('AI failure diagnostics persist only fixed codes and ignore untrusted item output', async () => {
  const secret = 'secret-not-for-receipts';
  const event = JSON.stringify({
    type: 'turn.failed',
    error: { message: `stream disconnected: Bearer ${secret}` },
  });
  assert.equal(classifyAiFailure(event), 'AI_NETWORK_ERROR');
  assert.equal(
    classifyAiFailure(JSON.stringify({ type: 'item.completed', item: { text: 'rate limit 429' } })),
    'NON_ZERO_EXIT',
  );
  assert.equal(
    classifyAiFailure(
      JSON.stringify({ type: 'error', message: 'invalid schema for response_format' }),
    ),
    'AI_INVALID_SCHEMA',
  );
  const command = {
    executable: NODE_BINARY,
    args: ['-e', `process.stdout.write(${JSON.stringify(event + '\n')}); process.exitCode=1;`],
    cwd: realpathSync(os.tmpdir()),
    env: { PATH: '/usr/bin:/bin' },
  };
  const subject = supervisorFixture({ command, actionId: 'ai-analyze' });
  await subject.next('ready');
  subject.child.stdin.write(
    JSON.stringify({ type: 'go', nonce: subject.nonce, command, input: '' }) + '\n',
  );
  const result = await subject.next('finished');
  assert.equal(result.failureReason, 'AI_NETWORK_ERROR');
  assert.equal(result.exitCode, 1);
  assert.ok(!readFileSync(subject.ticket, 'utf8').includes(secret));
  await closeSupervisor(subject);
});

test('review file transport grants exactly one trusted read without enlarging prompt or storage access', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const outputPath = realpathSync(fixture());
  const contract = runnerContract();
  const node = {
    ...contract.node,
    id: 'review',
    skills: ['project-context', 'code-review'],
    action: { id: 'ai-review' },
    resources: { reads: ['scripts/ai-graph'], writes: [], exclusive: [] },
  };
  contract.plan.nodes = [node];
  const content = JSON.stringify({ completeDiff: 'x'.repeat(40000) });
  const prepared = RUNNER_TESTING.makeAiCommand({
    ...contract,
    node,
    worktree: '/private/tmp/isolated-worktree',
    skills: [],
    priorEvidence: { path: '/private/tmp/forged-evidence' },
    reviewBundle: { content, bytes: Buffer.byteLength(content), hash: sha256(content) },
    outputPath,
    toolchain: { node: NODE_BINARY, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    profile: { outputPaths: [], ai: { provider: 'codex', model: 'fixture-model' } },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
  });
  try {
    assert.equal(readFileSync(prepared.reviewFile.path, 'utf8'), content);
    const filesystem = prepared.command.args.find((arg) =>
      arg.startsWith('permissions.graph-ai-review.filesystem='),
    );
    assert.ok(filesystem.includes(JSON.stringify(prepared.reviewFile.path)));
    assert.ok(!filesystem.includes('/private/tmp/forged-evidence'));
    assert.ok(!filesystem.includes(`${JSON.stringify(outputPath)}="read"`));
    assert.ok(filesystem.includes('"/private/tmp/isolated-worktree/.git"="deny"'));
    assert.ok(prepared.input.includes(prepared.reviewFile.path));
    assert.ok(prepared.input.includes('Прочитай весь JSON'));
    assert.ok(prepared.input.includes('не ограничивайся первым фрагментом'));
    assert.ok(!prepared.input.includes('x'.repeat(40000)));
    assert.ok(Buffer.byteLength(prepared.input) < 128 * 1024);
    const schema = JSON.parse(readFileSync(prepared.schemaFile, 'utf8'));
    assert.ok(schema.required.includes('reviewEvidenceHash'));
    assert.equal(schema.properties.edits.maxItems, 0);
    assert.equal(schema.properties.changedFiles.maxItems, 0);
    assert.deepEqual(schema.properties.skillsUsed.items.enum, node.skills);
    assert.equal(schema.properties.skillsUsed.minItems, node.skills.length);
    assert.equal(schema.properties.skillsUsed.maxItems, node.skills.length);
    assert.equal(schema.additionalProperties, false);
  } finally {
    RUNNER_TESTING.cleanupPrepared(prepared);
  }
  assert.equal(existsSync(prepared.reviewFile.path), false);
});

test('runner refuses missing review evidence before allocation or subprocess launch', async () => {
  const contract = runnerContract();
  contract.node.action = { id: 'ai-review', version: 1, inputs: {} };
  contract.node.permissions = ['ai.read'];
  contract.node.success = { kind: 'review', requiredArtifacts: ['review-findings'] };
  await assert.rejects(
    runRegisteredAction({
      ...contract,
      root: '/does-not-exist',
      worktree: '/does-not-exist',
      skills: [],
      onStart: async () => {},
    }),
    { code: 'REVIEW_EVIDENCE_INVALID' },
  );
});

test('failed prompt preparation releases the private evidence file and schema/result files', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const outputPath = realpathSync(fixture());
  const contract = runnerContract();
  const node = { ...contract.node, action: { id: 'ai-review' } };
  const content = 'complete evidence';
  assert.throws(
    () =>
      RUNNER_TESTING.makeAiCommand({
        ...contract,
        node,
        task: { ...contract.task, instructions: 'x'.repeat(128 * 1024) },
        worktree: '/private/tmp/isolated-worktree',
        skills: [],
        priorEvidence: null,
        reviewBundle: { content, bytes: Buffer.byteLength(content), hash: sha256(content) },
        outputPath,
        toolchain: { node: NODE_BINARY, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
        profile: { outputPaths: [], ai: { provider: 'codex', model: 'fixture-model' } },
        dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
      }),
    { code: 'RUNNER_PROMPT_LIMIT' },
  );
  assert.deepEqual(readdirSync(outputPath), []);
});

test('production cleanup closes parent FD after unconfirmed stop, retains file and is idempotent', async (t) => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const { createReviewEvidenceFile } = await import('./lib/review-evidence.mjs');
  const directory = realpathSync(fixture());
  const content = 'complete evidence';
  const file = createReviewEvidenceFile(directory, {
    content,
    bytes: Buffer.byteLength(content),
    hash: sha256(content),
  });
  const prepared = { reviewFile: file };
  const ownedFd = file.fd;
  // Occupy the lower descriptor released by the temporary writer during preparation.
  const reservation = openSync(file.path, 'r');
  t.after(() => closeSync(reservation));
  const result = { stopped: false, uncertain: true };
  RUNNER_TESTING.cleanupPrepared(prepared, result.stopped);
  assert.throws(() => fstatSync(ownedFd), { code: 'EBADF' });
  assert.equal(readFileSync(file.path, 'utf8'), content);
  assert.deepEqual(result, { stopped: false, uncertain: true });

  // Force the just-released descriptor number to belong to a different open file.
  const other = path.join(directory, 'other');
  writeFileSync(other, 'unrelated');
  const reusedFd = openSync(other, 'r');
  try {
    assert.equal(reusedFd, ownedFd);
    assert.doesNotThrow(() => RUNNER_TESTING.cleanupPrepared(prepared, false));
    assert.equal(readFileSync(reusedFd, 'utf8'), 'unrelated');
    assert.equal(existsSync(file.path), true);
    // Once stop is confirmed, repeated cleanup can unlink the original without touching reusedFd.
    RUNNER_TESTING.cleanupPrepared(prepared, true);
    assert.equal(existsSync(file.path), false);
    assert.ok(fstatSync(reusedFd).isFile());
  } finally {
    closeSync(reusedFd);
  }
});

test('production stopped cleanup removes its own evidence file and closes its parent FD', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const { createReviewEvidenceFile } = await import('./lib/review-evidence.mjs');
  const directory = realpathSync(fixture());
  const content = 'complete evidence';
  const file = createReviewEvidenceFile(directory, {
    content,
    bytes: Buffer.byteLength(content),
    hash: sha256(content),
  });
  const ownedFd = file.fd;
  RUNNER_TESTING.cleanupPrepared({ reviewFile: file }, true);
  assert.throws(() => fstatSync(ownedFd), { code: 'EBADF' });
  assert.equal(existsSync(file.path), false);
});

test('ручной выбор сохраняет модель и усиление review, fresh exec не возобновляет историю', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const contract = runnerContract();
  const node = { ...contract.node, id: 'review', action: { id: 'ai-review' } };
  contract.plan.nodes = [node];
  const content = '{}';
  const prepared = RUNNER_TESTING.makeAiCommand({ ...contract, node, worktree: '/private/tmp/isolated-worktree', skills: [], priorEvidence: null,
    reviewBundle: { content, bytes: 2, hash: sha256(content) }, outputPath: realpathSync(fixture()),
    toolchain: { node: NODE_BINARY, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    profile: { outputPaths: [], ai: { provider: 'codex', model: 'chosen-model', reviewModel: 'other-model', modelMode: 'manual', reasoningEffort: 'low', reviewReasoningEffort: 'high' } },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) } });
  try {
    const args = prepared.command.args;
    assert.equal(args[args.indexOf('--model') + 1], 'chosen-model');
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.ok(args.includes('--ephemeral')); assert.ok(!args.includes('resume'));
    assert.equal(prepared.execution.model, 'chosen-model');
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});

test('режим provider не переопределяет модель и усиление, выбранные в Codex', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const contract = runnerContract();
  const outputPath = realpathSync(fixture());
  const prepared = RUNNER_TESTING.makeAiCommand({ ...contract, worktree: '/private/tmp/isolated-worktree', skills: [], priorEvidence: null, outputPath,
    profile: { outputPaths: [], ai: { provider: 'codex', model: 'provider-default', modelMode: 'provider' } },
    toolchain: { node: NODE_BINARY, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
  });
  try {
    assert.equal(prepared.command.args.includes('--model'), false);
    assert.equal(prepared.command.args.some((value) => value.startsWith('model_reasoning_effort=')), false);
    assert.equal(prepared.execution.model, 'provider-default');
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});

test('большой lock исключается из AI context, его hash остается частью workspace integrity', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const { fingerprintWorkspace } = await import('./lib/workspace.mjs');
  const { spawnSync } = await import('node:child_process');
  const root = realpathSync(fixture());
  assert.equal(spawnSync('/usr/bin/git',['init','-q',root]).status,0);
  writeFileSync(path.join(root,'form.mjs'),'export const valid = true;');
  writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({padding:'x'.repeat(600 * 1024)}));
  const profile={outputPaths:[]};
  const node={resources:{reads:['form.mjs','package-lock.json']}};
  const task={scope:node.resources.reads,contextPaths:[],forbiddenPaths:[]};
  const before=fingerprintWorkspace(root);
  const selected=RUNNER_TESTING.selectedSourceContext(root,node,task,profile);
  assert.deepEqual(selected.map(file=>file.path),['form.mjs']);
  assert.ok(before.files.some(file=>file.path==='package-lock.json'));
  assert.ok(RUNNER_TESTING.instructionDenials(root,node,profile).includes('package-lock.json'));
  writeFileSync(path.join(root,'package-lock.json'),'{}');
  assert.notEqual(fingerprintWorkspace(root).hash,before.hash);
});

test('соседний AGENT.md не входит в scoped AI context и запрещен Codex sandbox', async () => {
 const { RUNNER_TESTING } = await import('./lib/runner.mjs');
 const { spawnSync } = await import('node:child_process');
 const { mkdirSync } = await import('node:fs');
 const root=realpathSync(fixture());assert.equal(spawnSync('/usr/bin/git',['init','-q',root]).status,0);
 mkdirSync(path.join(root,'apps/api'),{recursive:true});mkdirSync(path.join(root,'apps/web'),{recursive:true});
 writeFileSync(path.join(root,'apps/api/AGENT.md'),'API rules');writeFileSync(path.join(root,'apps/web/AGENT.md'),'Web rules');
 writeFileSync(path.join(root,'apps/api/index.mjs'),'export const ok=true;');
 const task={scope:['apps'],contextPaths:[],forbiddenPaths:[]};
 const node={resources:{reads:['apps','apps/api/AGENT.md']}};const profile={outputPaths:[]};
 const selected=RUNNER_TESTING.selectedSourceContext(root,node,task,profile);
 assert.ok(selected.some(file=>file.path==='apps/api/AGENT.md'));
 assert.ok(!selected.some(file=>file.path==='apps/web/AGENT.md'));
 assert.ok(RUNNER_TESTING.instructionDenials(root,node,profile).includes('apps/web/AGENT.md'));
});


test('схема edits ограничена буквальными путями текущего узла', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const outputPath = realpathSync(fixture());
  const contract = runnerContract();
  const node = { ...contract.node, action: { id: 'ai-implement', version: 1, inputs: {} }, skills: ['project-context'], resources: { reads: ['src', 'styles.css'], writes: ['src/form.mjs', 'styles.css'], exclusive: [] } };
  const prepared = RUNNER_TESTING.makeAiCommand({ ...contract, node, plan: { ...contract.plan, nodes: [node] }, worktree: '/private/tmp/isolated-worktree', skills: [], priorEvidence: null, outputPath,
    profile: { ai: { model: 'fixture-model' }, outputPaths: [] },
    toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
  });
  try {
    const schema = JSON.parse(readFileSync(prepared.schemaFile, 'utf8'));
    const pattern = new RegExp(schema.properties.edits.items.properties.path.pattern);
    assert.ok(pattern.test('src/form.mjs')); assert.ok(pattern.test('styles.css'));
    assert.equal(pattern.test('src/formXmjs'), false); assert.equal(pattern.test('index.html'), false);
    assert.match(prepared.input, /только для текущего узла: src\/form.mjs, styles.css/);
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});

test('prompt отделяет запрет корня worktree от разрешенных read paths', async () => {
  const { RUNNER_TESTING } = await import('./lib/runner.mjs');
  const outputPath = realpathSync(fixture());
  const contract = runnerContract();
  const node = {
    ...contract.node,
    action: { id: 'ai-implement', version: 1, inputs: {} },
    resources: { reads: ['index.html', 'styles.css', 'src'], writes: ['src/form.mjs'], exclusive: [] },
  };
  const worktree = '/private/tmp/isolated-worktree';
  const prepared = RUNNER_TESTING.makeAiCommand({ ...contract, node, plan: { ...contract.plan, nodes: [node] }, worktree, skills: [], priorEvidence: null, outputPath,
    profile: { ai: { model: 'fixture-model' }, outputPaths: [] },
    toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
  });
  try {
    const filesystem = prepared.command.args.find((item) => item.startsWith('permissions.graph-ai-implement.filesystem='));
    assert.ok(filesystem.includes(`${JSON.stringify(worktree)}="deny"`));
    for (const relative of node.resources.reads)
      assert.ok(filesystem.includes(`${JSON.stringify(path.join(worktree, relative))}="read"`));
    assert.match(prepared.input, /не запускай ls \./i);
    assert.match(prepared.input, /точно перечисленные paths/i);
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});
