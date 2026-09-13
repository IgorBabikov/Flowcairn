import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DOCKER_CHECKS_TESTING, probeChecks } from './lib/docker-checks.mjs';
import {
  copyFingerprintSource,
  seedPreparedWorkspace,
  registeredContainerCheck,
  registeredContainerCommands,
  runBoundedCommand,
  summarizeCheckFailure,
} from './container-check.mjs';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';

function temporary(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function contextFixture(t) {
  const root = temporary(t, 'flowcairn-docker-context-');
  for (const relative of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'apps/api/package.json',
    'apps/web/package.json',
    'packages/shared/package.json',
    'packages/voice-pipeline/package.json',
    'tools/ai-graph-viewer/package.json',
    'scripts/ai-graph/Dockerfile.checks',
    'scripts/ai-graph/container-check.mjs',
  ]) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${relative}\n`);
  }
  writeFileSync(
    path.join(root, 'package.json'), JSON.stringify({ name: 'checks-fixture', version: '1.0.0' }),
  );
  writeFileSync(
    path.join(root, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'main',
      packageManager: 'pnpm',
      contextPaths: [],
      checks: ['tests'],
      outputPaths: [],
      manifests: [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'apps/api/package.json',
        'apps/web/package.json',
        'packages/shared/package.json',
        'packages/voice-pipeline/package.json',
        'tools/ai-graph-viewer/package.json',
      ],
      ai: { provider: 'openai', model: 'fixture-model' },
    }),
  );
  return root;
}

test('build context hash contains only fixed manifests, lock, Dockerfile, and entry script', (t) => {
  const root = contextFixture(t);
  const baseId = `sha256:${'a'.repeat(64)}`;
  const first = DOCKER_CHECKS_TESTING.contextDescription(root, baseId);
  const second = DOCKER_CHECKS_TESTING.contextDescription(root, baseId);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.sources.filter((entry) => entry.projectInput).map((entry) => entry.target),
    JSON.parse(readFileSync(path.join(root, '.flowcairn.json'))).manifests.map(
      (value) => `manifests/${value}`,
    ),
  );
  writeFileSync(path.join(root, 'apps/api/src-secret.txt'), 'not part of context');
  assert.equal(DOCKER_CHECKS_TESTING.contextDescription(root, baseId).hash, first.hash);
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'changed\n');
  assert.notEqual(DOCKER_CHECKS_TESTING.contextDescription(root, baseId).hash, first.hash);
});

test('build context rejects symlinked manifest inputs', (t) => {
  const root = contextFixture(t);
  const target = path.join(root, 'outside-package.json');
  writeFileSync(target, '{}\n');
  rmSync(path.join(root, 'apps/api/package.json'));
  symlinkSync(target, path.join(root, 'apps/api/package.json'));
  assert.throws(
    () => DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`),
    (error) => error instanceof GraphError && error.code === 'CHECK_CONTEXT_UNSAFE',
  );
});

test('build context rejects a symlinked manifest ancestor', (t) => {
  const root = contextFixture(t);
  const outside = temporary(t, 'flowcairn-docker-outside-');
  mkdirSync(path.join(outside, 'api'));
  writeFileSync(path.join(outside, 'api/package.json'), '{}\n');
  rmSync(path.join(root, 'apps'), { recursive: true });
  symlinkSync(outside, path.join(root, 'apps'));
  assert.throws(
    () => DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`),
    (error) => error instanceof GraphError && error.code === 'CHECK_CONTEXT_UNSAFE',
  );
});

test('container create argv has fixed containment and no host write mount', () => {
  const input = {
    worktree: '/repo/.ai-orchestrator/worktrees/TASK/attempt-1',
    action: { id: 'check-tests' },
  };
  const image = { imageId: `sha256:${'b'.repeat(64)}` };
  const labels = {
    'com.flowcairn.check-container': 'true',
    'com.flowcairn.contract-hash': 'c'.repeat(64),
  };
  const args = DOCKER_CHECKS_TESTING.createArguments({
    input,
    image,
    contractFile: '/repo/.ai-orchestrator/graph/output-attempt/contract.json',
    labels,
    name: 'flowcairn-graph-task-check-tests-abc',
  });
  assert.equal(args[0], 'create');
  assert.ok(args.includes('none'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges=true'));
  assert.equal(args.includes('--pid'), false);
  assert.ok(args.includes('compress=false'));
  assert.ok(args.includes('COREPACK_HOME=/opt/corepack'));
  assert.equal(DOCKER_CHECKS_TESTING.intendedSecurity(input, '/contract.json').pidMode, '');
  assert.equal(args.includes('type=volume,dst=/workspace'), false);
  assert.ok(
    args.includes(
      '/workspace:rw,nosuid,nodev,size=1073741824,nr_inodes=131072,uid=1000,gid=1000,mode=0700',
    ),
  );
  assert.match(
    DOCKER_CHECKS_TESTING.intendedSecurity(input, '/contract.json').tmpfs['/workspace'],
    /size=1073741824,nr_inodes=131072/,
  );
  const mounts = args.filter((value) => value.startsWith('type='));
  assert.deepEqual(mounts, [
    'type=bind,src=/repo/.ai-orchestrator/worktrees/TASK/attempt-1,dst=/input,readonly',
    'type=bind,src=/repo/.ai-orchestrator/graph/output-attempt/contract.json,dst=/contract.json,readonly',
  ]);
  assert.equal(args.at(-2), image.imageId);
  assert.equal(args.at(-1), 'check-tests');
  assert.equal(
    args.some((value) => value.includes('docker.sock')),
    false,
  );
});

test('delayed Docker create reconciles within the fixed preparation budget', async () => {
  let now = 0;
  let inspections = 0;
  const matched = { Id: 'a'.repeat(64) };
  const result = await DOCKER_CHECKS_TESTING.reconcileCreatedContainer(
    'exact-name',
    {},
    {
      budgetMs: 1_000,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      inspect: () => {
        inspections += 1;
        return inspections < 3
          ? { status: 'absent', value: null }
          : { status: 'match', value: matched };
      },
    },
  );
  assert.deepEqual(result, { status: 'match', value: matched });
  assert.equal(inspections, 3);
  assert.equal(now, 500);
  assert.equal(DOCKER_CHECKS_TESTING.createPreparationTimeoutMs, 120_000);
  assert.equal(DOCKER_CHECKS_TESTING.createReconciliationTimeoutMs, 30_000);
});

test('foreign Docker create identity is rejected without reconciliation delay', async () => {
  const expected = {
    imageId: `sha256:${'b'.repeat(64)}`,
    labels: {},
    name: 'expected-name',
    securityHash: 'c'.repeat(64),
  };
  const classified = DOCKER_CHECKS_TESTING.classifyCreatedContainer(
    {
      Id: 'a'.repeat(64),
      Image: expected.imageId,
      Name: '/foreign-name',
      State: { Running: false },
      Config: { Labels: {} },
    },
    expected,
  );
  assert.equal(classified.status, 'foreign');
  let waited = false;
  const result = await DOCKER_CHECKS_TESTING.reconcileCreatedContainer('expected-name', expected, {
    inspect: () => classified,
    wait: async () => {
      waited = true;
    },
  });
  assert.equal(result.status, 'foreign');
  assert.equal(waited, false);
});

test('final pre-start verification rejects a container started after reconciliation', () => {
  const value = {
    Id: 'a'.repeat(64),
    Image: `sha256:${'b'.repeat(64)}`,
    Name: '/expected-name',
    State: {
      Running: false,
      Status: 'created',
      Pid: 0,
      StartedAt: '0001-01-01T00:00:00Z',
    },
    Config: { Labels: {} },
    HostConfig: {},
    Mounts: [],
  };
  const expected = {
    imageId: value.Image,
    labels: {},
    name: 'expected-name',
    securityHash: hashObject(DOCKER_CHECKS_TESTING.actualSecurity(value)),
  };
  assert.equal(
    DOCKER_CHECKS_TESTING.confirmCreatedBeforeStart(value.Id, expected, () => value).status,
    'match',
  );
  const previouslyStarted = structuredClone(value);
  previouslyStarted.State.Status = 'exited';
  previouslyStarted.State.StartedAt = '2026-09-13T00:00:00.000000000Z';
  assert.equal(
    DOCKER_CHECKS_TESTING.confirmCreatedBeforeStart(value.Id, expected, () => previouslyStarted)
      .status,
    'foreign',
  );
});

test('final pre-start verification rejects a different actual container id', () => {
  const value = {
    Id: 'a'.repeat(64),
    Image: `sha256:${'b'.repeat(64)}`,
    Name: '/expected-name',
    State: {
      Running: false,
      Status: 'created',
      Pid: 0,
      StartedAt: '0001-01-01T00:00:00.000000000Z',
    },
    Config: { Labels: {} },
    HostConfig: {},
    Mounts: [],
  };
  const expected = {
    imageId: value.Image,
    labels: {},
    name: 'expected-name',
    securityHash: hashObject(DOCKER_CHECKS_TESTING.actualSecurity(value)),
  };
  assert.equal(
    DOCKER_CHECKS_TESTING.confirmCreatedBeforeStart('c'.repeat(64), expected, () => value).status,
    'foreign',
  );
});

test('Docker create reconciliation cannot exceed its explicit time budget', async () => {
  let now = 0;
  const inspectTimeouts = [];
  let waited = 0;
  const result = await DOCKER_CHECKS_TESTING.reconcileCreatedContainer(
    'exact-name',
    {},
    {
      budgetMs: 600,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
        waited += milliseconds;
      },
      inspect: (_reference, _expected, timeout) => {
        inspectTimeouts.push(timeout);
        now += Math.min(200, timeout);
        return { status: 'absent', value: null };
      },
    },
  );
  assert.deepEqual(result, { status: 'timeout', value: null });
  assert.equal(now, 600);
  assert.equal(waited, 250);
  assert.ok(inspectTimeouts.every((timeout) => timeout >= 1 && timeout <= 600));
  assert.ok(inspectTimeouts.length <= 3);
});

test('container copies only hash-bound regular source files into disposable workspace', (t) => {
  const root = temporary(t, 'flowcairn-container-copy-');
  const input = path.join(root, 'input');
  const workspace = path.join(root, 'workspace');
  mkdirSync(path.join(input, 'src'), { recursive: true });
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(input, 'src/file.txt'), 'verified\n');
  writeFileSync(path.join(input, 'ignored.txt'), 'ignored\n');
  writeFileSync(path.join(workspace, 'src/file.txt'), 'image baseline\n');
  const stat = lstatSync(path.join(input, 'src/file.txt'));
  const files = [
    {
      path: 'src/file.txt',
      hash: sha256(readFileSync(path.join(input, 'src/file.txt'))),
      mode: '100644',
      size: stat.size,
    },
  ];
  copyFingerprintSource({ input, workspace, files });
  assert.equal(readFileSync(path.join(workspace, 'src/file.txt'), 'utf8'), 'verified\n');
  assert.equal(exists(path.join(workspace, 'ignored.txt')), false);
});

test('container rejects source hash drift and symlinks', (t) => {
  const root = temporary(t, 'flowcairn-container-reject-');
  const input = path.join(root, 'input');
  const workspace = path.join(root, 'workspace');
  mkdirSync(path.join(input, 'src'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(input, 'src/file.txt'), 'current\n');
  const stat = lstatSync(path.join(input, 'src/file.txt'));
  const drifted = [{ path: 'src/file.txt', hash: '0'.repeat(64), mode: '100644', size: stat.size }];
  assert.throws(() => copyFingerprintSource({ input, workspace, files: drifted }), /SOURCE_DRIFT/);
  rmSync(path.join(input, 'src/file.txt'));
  symlinkSync(path.join(root, 'outside'), path.join(input, 'src/file.txt'));
  assert.throws(() => copyFingerprintSource({ input, workspace, files: drifted }));
});

test('container check registry maps only fixed pnpm scripts', () => {
  assert.deepEqual(registeredContainerCheck('check-typecheck', { packageManager: 'pnpm' }), {
    executable: '/usr/local/bin/node',
    args: ['/opt/flowcairn/package-manager.cjs', 'run', 'typecheck'],
  });
  assert.deepEqual(registeredContainerCheck('check-build', { packageManager: 'pnpm' }), {
    executable: '/usr/local/bin/node',
    args: ['/opt/flowcairn/package-manager.cjs', 'run', 'build'],
  });
  assert.throws(
    () => registeredContainerCheck('ai-implement', { packageManager: 'pnpm' }),
    /UNSUPPORTED_CHECK/,
  );
});

test('failed check evidence is bounded, targeted, and redacted', () => {
  const summary = summarizeCheckFailure(
    'progress\n/workspace/apps/api/src/main.ts(4,2): error TS1234: bad type\n',
    'TOKEN=very-secret-value-that-must-not-leak\nBearer=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK\n',
  );
  assert.match(summary, /apps\/api\/src\/main\.ts/);
  assert.match(summary, /TS1234/);
  assert.doesNotMatch(summary, /\/workspace|very-secret|abcdefghijklmnopqrstuvwxyz/);
  assert.ok(summary.length <= 1_600);
  assert.equal(
    summarizeCheckFailure('', '', { outputLimit: true }),
    'Check output exceeded 4194304 byte limit',
  );
});

test('host accepts only the trusted wrapper result envelope', () => {
  const parse = DOCKER_CHECKS_TESTING.parseCheckResult;
  assert.deepEqual(
    parse('FLOWCAIRN_CHECK_RESULT {"version":1,"exitCode":1,"summary":"type error"}\n', 1),
    { version: 1, exitCode: 1, summary: 'type error' },
  );
  assert.equal(parse('raw tool output\nFLOWCAIRN_CHECK_RESULT {}\n', 1), null);
  assert.equal(
    parse('FLOWCAIRN_CHECK_RESULT {"version":1,"exitCode":0,"summary":"fake failure"}\n', 0),
    null,
  );
});

test('Docker daemon failures are bounded and redact host paths and credentials', () => {
  const diagnostic = DOCKER_CHECKS_TESTING.boundedDockerDiagnostic(
    {
      stderr:
        'mount /private/tmp/repo failed\nerror TOKEN=secret-value-that-must-not-leak-1234567890',
      stdout: '',
    },
    'START_FAILED',
    ['/private/tmp/repo'],
  );
  assert.match(diagnostic, /^START_FAILED:/);
  assert.match(diagnostic, /<host-path>/);
  assert.doesNotMatch(diagnostic, /\/private\/tmp\/repo|must-not-leak/);
  assert.ok(diagnostic.length <= 1_014);
});

test('Docker CLI routing ignores inherited remote contexts', () => {
  const previous = {
    host: process.env.DOCKER_HOST,
    context: process.env.DOCKER_CONTEXT,
    config: process.env.DOCKER_CONFIG,
  };
  process.env.DOCKER_HOST = 'tcp://remote.invalid:2375';
  process.env.DOCKER_CONTEXT = 'foreign';
  process.env.DOCKER_CONFIG = '/tmp/foreign-docker-config';
  try {
    const environment = DOCKER_CHECKS_TESTING.dockerEnvironment('/var/run/docker.sock');
    assert.match(environment.DOCKER_HOST, /^unix:\/\//);
    assert.equal('DOCKER_CONTEXT' in environment, false);
    assert.equal('DOCKER_CONFIG' in environment, false);
  } finally {
    if (previous.host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous.host;
    if (previous.context === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previous.context;
    if (previous.config === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previous.config;
  }
});

test('unknown Docker start is stopped, proven, and removed before returning', async () => {
  const calls = [];
  const runtime = {
    start: () => {
      calls.push('start');
      throw new Error('transport timeout after daemon start');
    },
    stop: () => calls.push('stop'),
    wait: async () => {
      calls.push('wait');
      return { exitCode: 137 };
    },
    inspect: () => {
      calls.push('inspect');
      return {
        State: {
          Running: false,
          Status: 'exited',
          ExitCode: 137,
          FinishedAt: '2026-09-12T12:00:00.000000000Z',
          OOMKilled: false,
        },
      };
    },
    writeProof: () => {
      calls.push('proof');
      return { proofHash: 'a'.repeat(64), path: '.ai-orchestrator/graph/proof.json' };
    },
    logs: () => null,
    remove: () => {
      calls.push('remove');
      return true;
    },
  };
  const result = await DOCKER_CHECKS_TESTING.superviseContainer({
    runtime,
    timeoutMs: 1_000,
  });
  assert.deepEqual(calls, ['start', 'stop', 'wait', 'inspect', 'proof', 'remove']);
  assert.equal(result.failureReason, 'START_UNKNOWN');
  assert.equal(result.stopProof.proofHash, 'a'.repeat(64));
  assert.equal(result.removed, true);
});

function processFixture() {
  const process = {
    version: 1,
    kind: 'docker-check',
    containerId: 'a'.repeat(64),
    name: 'flowcairn-graph-task-check-123',
    imageId: `sha256:${'b'.repeat(64)}`,
    imageHash: 'c'.repeat(64),
    actionId: 'check-typecheck',
    taskId: 'ORCH-DOCKER',
    nodeId: 'typecheck',
    planHash: 'd'.repeat(64),
    attemptId: 'attempt-one',
    contractHash: 'e'.repeat(64),
    securityHash: 'f'.repeat(64),
    createdAt: '2026-09-12T12:00:00.000Z',
  };
  process.labels = {
    'com.flowcairn.check-container': 'true',
    'com.flowcairn.task-id': process.taskId,
    'com.flowcairn.node-id': process.nodeId,
    'com.flowcairn.plan-hash': process.planHash,
    'com.flowcairn.attempt-id': process.attemptId,
    'com.flowcairn.contract-hash': process.contractHash,
    'com.flowcairn.image-id': process.imageId,
    'com.flowcairn.security-hash': process.securityHash,
  };
  return process;
}

test('durable stop proof makes removed-container recovery idempotent', async (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-');
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const metadata = processFixture();
  let removes = 0;
  const stopped = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 137,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  const runtime = {
    available: () => true,
    inspect: () => stopped,
    wait: async () => ({ exitCode: 137 }),
    writeProof: (inspected, waited) =>
      DOCKER_CHECKS_TESTING.writeStopProof(root, metadata, inspected, waited),
    logs: () => null,
    remove: () => {
      removes += 1;
      return true;
    },
  };
  const first = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, runtime);
  assert.equal(first.stopped, true);
  assert.equal(removes, 1);
  const replay = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, {
    available: () => false,
    inspect: () => assert.fail('durable replay must not inspect an absent container'),
  });
  assert.equal(replay.stopped, true);
  assert.equal(replay.uncertain, false);
  assert.equal(replay.exitCode, 137);
  assert.equal(removes, 1);
});

test('partial temporary proof retains the container and recovery publishes a valid proof', async (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-partial-');
  const proofDirectory = path.join(root, '.ai-orchestrator', 'graph', 'check-stop-proofs');
  mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
  const metadata = processFixture();
  const location = DOCKER_CHECKS_TESTING.stopProofPath(root, metadata);
  writeFileSync(
    path.join(proofDirectory, `.${location.metadataHash}.999.partial.tmp`),
    '{"partial":',
    { mode: 0o600 },
  );
  let removed = false;
  const terminal = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 137,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  const result = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, {
    available: () => true,
    inspect: () => terminal,
    wait: async () => ({ exitCode: 137 }),
    writeProof: (inspected, waited) =>
      DOCKER_CHECKS_TESTING.writeStopProof(root, metadata, inspected, waited),
    logs: () => null,
    remove: () => {
      removed = true;
      return true;
    },
  });
  assert.equal(result.stopped, true);
  assert.equal(removed, true);
  assert.equal(DOCKER_CHECKS_TESTING.readStopProof(root, metadata).proofHash.length, 64);
});

test('recovery completes an interrupted exclusive proof publication', (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-published-');
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const metadata = processFixture();
  const terminal = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 0,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  const proof = DOCKER_CHECKS_TESTING.writeStopProof(root, metadata, terminal, { exitCode: 0 });
  const file = path.join(root, proof.path);
  const location = DOCKER_CHECKS_TESTING.stopProofPath(root, metadata);
  const interrupted = path.join(
    path.dirname(file),
    `.${location.metadataHash}.777.interrupted.tmp`,
  );
  linkSync(file, interrupted);
  assert.equal(lstatSync(file).nlink, 2);
  assert.equal(DOCKER_CHECKS_TESTING.readStopProof(root, metadata).proofHash, proof.proofHash);
  assert.equal(exists(interrupted), false);
  assert.equal(lstatSync(file).nlink, 1);
});

test('recovery re-fsyncs proof after crash between unlink and directory fsync', async (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-dir-fsync-');
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const metadata = processFixture();
  const terminal = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 137,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  assert.throws(
    () =>
      DOCKER_CHECKS_TESTING.writeStopProof(
        root,
        metadata,
        terminal,
        { exitCode: 137 },
        {
          syncPublishedDirectory: () => {
            throw new Error('simulated crash before directory fsync');
          },
        },
      ),
    /simulated crash/,
  );
  const location = DOCKER_CHECKS_TESTING.stopProofPath(root, metadata);
  assert.equal(lstatSync(location.file).nlink, 1);
  let fileSyncs = 0;
  let directorySyncs = 0;
  DOCKER_CHECKS_TESTING.readStopProof(root, metadata, {
    syncFile: () => {
      fileSyncs += 1;
    },
    syncDirectory: () => {
      directorySyncs += 1;
    },
  });
  assert.equal(fileSyncs, 1);
  assert.equal(directorySyncs, 1);
  let removed = false;
  const replay = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, {
    available: () => true,
    inspect: () => terminal,
    remove: () => {
      removed = true;
      return true;
    },
  });
  assert.equal(replay.stopped, true);
  assert.equal(replay.uncertain, false);
  assert.equal(removed, true);
});

test('container absence without durable proof remains uncertain', async (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-absent-');
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const result = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, processFixture(), {
    available: () => true,
    inspect: () => null,
  });
  assert.deepEqual(result, {
    stopped: false,
    uncertain: true,
    failureReason: 'CONTAINER_NOT_FOUND',
  });
});

test('stop proof rejects unsafe file mode', async (t) => {
  const root = temporary(t, 'flowcairn-stop-proof-mode-');
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const metadata = processFixture();
  const stopped = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 0,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  const proof = DOCKER_CHECKS_TESTING.writeStopProof(root, metadata, stopped, { exitCode: 0 });
  const file = path.join(root, proof.path);
  chmodSync(file, 0o644);
  const result = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, {
    available: () => false,
  });
  assert.deepEqual(result, {
    stopped: false,
    uncertain: true,
    failureReason: 'STOP_PROOF_INVALID',
  });
});

test('stop proof rejects symlinks and hardlinks', async (t) => {
  const terminal = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 0,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  for (const kind of ['symlink', 'hardlink']) {
    const root = temporary(t, `flowcairn-stop-proof-${kind}-`);
    mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
    const metadata = processFixture();
    const proof = DOCKER_CHECKS_TESTING.writeStopProof(root, metadata, terminal, { exitCode: 0 });
    const file = path.join(root, proof.path);
    const outside = path.join(root, 'outside-proof.json');
    writeFileSync(outside, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    if (kind === 'symlink') symlinkSync(outside, file);
    else linkSync(outside, file);
    const result = await DOCKER_CHECKS_TESTING.recoverCheckProcess(root, metadata, {
      available: () => false,
    });
    assert.equal(result.failureReason, 'STOP_PROOF_INVALID');
  }
});

test('container-local watchdog terminates a bounded hanging child', async () => {
  const started = Date.now();
  const result = await runBoundedCommand(
    { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
    { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 50 },
  );
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2_000);
});

test('unknown wait still finalizes and always removes abort listener', async () => {
  const controller = new AbortController();
  let waits = 0;
  let stops = 0;
  const runtime = {
    start: () => ({ status: 0, error: null, signal: null }),
    stop: () => {
      stops += 1;
    },
    wait: async () => {
      waits += 1;
      if (waits === 1) throw new Error('wait transport lost');
      return { exitCode: 137 };
    },
    inspect: () => ({
      State: {
        Running: false,
        Status: 'exited',
        ExitCode: 137,
        FinishedAt: '2026-09-12T12:00:00.000000000Z',
        OOMKilled: false,
      },
    }),
    writeProof: () => ({ proofHash: 'a'.repeat(64), path: 'proof.json' }),
    logs: () => null,
    remove: () => true,
  };
  const result = await DOCKER_CHECKS_TESTING.superviseContainer({
    runtime,
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  assert.equal(result.failureReason, 'WAIT_UNKNOWN');
  assert.equal(result.stopProof.proofHash, 'a'.repeat(64));
  assert.equal(waits, 2);
  const stopsAfterReturn = stops;
  controller.abort();
  assert.equal(stops, stopsAfterReturn);
});

test('probe returns a bounded availability result without creating state', (t) => {
  const root = contextFixture(t);
  const before = realpathSync(root);
  const result = probeChecks({ root });
  assert.equal(typeof result.available, 'boolean');
  assert.ok(result.reason === null || /^[A-Z_]+$/.test(result.reason));
  assert.equal(realpathSync(root), before);
});

function exists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('container registry dispatches only explicit npm and pnpm script IDs', () => {
  for (const packageManager of ['npm', 'pnpm']) {
    for (const [action, script] of [
      ['check-tests', 'test'],
      ['check-typecheck', 'typecheck'],
      ['check-lint', 'lint'],
      ['check-build', 'build'],
    ]) {
      const commands = registeredContainerCommands(action, { packageManager });
      assert.equal(commands.length, 1);
      assert.deepEqual(commands[0].args.slice(1), ['run', script]);
    }
  }
  assert.throws(
    () => registeredContainerCommands('arbitrary-shell', { packageManager: 'npm' }),
    /UNSUPPORTED_CHECK/,
  );
  assert.throws(
    () => registeredContainerCommands('check-tests', { packageManager: 'sh' }),
    /INVALID_CONTRACT/,
  );
});

test('rejects changed dependency manifests instead of installing during a check', (t) => {
  const root = contextFixture(t);
  const description = DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`);
  assert.doesNotThrow(() => DOCKER_CHECKS_TESTING.verifyDependencyInputs(root, description));
  writeFileSync(
    path.join(root, 'tools/ai-graph-viewer/package.json'),
    '{"dependencies":{"new":"1"}}',
  );
  assert.throws(
    () => DOCKER_CHECKS_TESTING.verifyDependencyInputs(root, description),
    (error) => error instanceof GraphError && error.code === 'CHECK_DEPENDENCIES_DRIFT',
  );
});

test('prepared workspace seed preserves relative workspace links and refuses overwrites', (t) => {
  const root = temporary(t, 'flowcairn-seed-');
  const seed = path.join(root, 'seed'),
    workspace = path.join(root, 'workspace');
  mkdirSync(path.join(seed, 'node_modules'), { recursive: true });
  mkdirSync(path.join(seed, 'packages/lib'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(seed, 'packages/lib/package.json'), '{"name":"lib"}');
  symlinkSync('../packages/lib', path.join(seed, 'node_modules/lib'));
  seedPreparedWorkspace({ seed, workspace });
  writeFileSync(path.join(workspace, 'packages/lib/index.js'), 'export const value = 1;');
  assert.equal(
    readFileSync(path.join(workspace, 'node_modules/lib/index.js'), 'utf8'),
    'export const value = 1;',
  );
  assert.equal(exists(path.join(seed, 'packages/lib/index.js')), false);
  assert.throws(() => seedPreparedWorkspace({ seed, workspace }));
});
