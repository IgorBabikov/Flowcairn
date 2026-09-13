import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256 } from './lib/io.mjs';
import { GRAPH_STORE_LIMITS, GraphStore } from './lib/store.mjs';

const TEST_TMP_ROOT = realpathSync(os.tmpdir());
const STORE_MODULE = new URL('./lib/store.mjs', import.meta.url).href;

function fixture() {
  return mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-graph-store-'));
}

function runDirectory(root, runId) {
  return path.join(root, '.ai-orchestrator', 'graph', 'runs', runId);
}

function objectFile(root, kind, hash) {
  return path.join(root, '.ai-orchestrator', 'graph', kind, `${hash}.json`);
}

function assertCode(code) {
  return (error) => error?.code === code;
}

function childUpdate(root, runId) {
  const code = `
    import { GraphStore } from ${JSON.stringify(STORE_MODULE)};
    const store = new GraphStore(process.argv[1]);
    try {
      store.updateRun(process.argv[2], 0, (state) => ({ ...state, winner: process.pid }));
      process.stdout.write('ok');
      process.exit(0);
    } catch (error) {
      process.stdout.write(error.code ?? 'UNKNOWN');
      process.exit(2);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, runId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('read APIs are pure before initialization', () => {
  const root = fixture();
  const store = new GraphStore(root);

  assert.deepEqual(store.listRunIds(), []);
  assert.equal(store.inspectLock('pure-read-run'), null);
  assert.throws(() => store.readRun('pure-read-run'), assertCode('STORE_NOT_FOUND'));
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
});

test('creates, reads, updates and pages an immutable committed revision chain', () => {
  const root = fixture();
  const store = new GraphStore(root);
  const initial = store.createRun('history-run', { status: 'draft', nodes: [] });

  assert.deepEqual(initial, {
    nodes: [],
    revision: 0,
    runId: 'history-run',
    status: 'draft',
  });
  const updated = store.updateRun('history-run', 0, (state) => {
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.nodes), true);
    return { ...state, status: 'ready' };
  });
  assert.equal(updated.revision, 1);
  assert.equal(store.readRun('history-run').status, 'ready');
  assert.deepEqual(
    store.history('history-run').map(({ revision, status }) => ({ revision, status })),
    [
      { revision: 0, status: 'draft' },
      { revision: 1, status: 'ready' },
    ],
  );
  assert.deepEqual(store.history('history-run', { afterRevision: 0, limit: 1 }), [updated]);
  assert.deepEqual(store.listRunIds(), ['history-run']);

  const directory = runDirectory(root, 'history-run');
  assert.equal(lstatSync(directory).mode & 0o077, 0);
  assert.equal(lstatSync(path.join(directory, 'state.json')).mode & 0o077, 0);
  assert.equal(
    readdirSync(path.join(directory, 'revisions')).filter((name) => !name.startsWith('.')).length,
    2,
  );
});

test('create is idempotent and stale CAS never invokes its updater', () => {
  const root = fixture();
  const store = new GraphStore(root);
  const initialInput = { status: 'draft' };
  const first = store.createRun('idempotent-run', initialInput);
  assert.deepEqual(store.createRun('idempotent-run', initialInput), first);
  assert.throws(
    () => store.createRun('idempotent-run', { status: 'different' }),
    assertCode('RUN_EXISTS'),
  );

  store.updateRun('idempotent-run', 0, (state) => ({ ...state, status: 'ready' }));
  let invoked = false;
  assert.throws(
    () =>
      store.updateRun('idempotent-run', 0, () => {
        invoked = true;
        return {};
      }),
    assertCode('CAS_CONFLICT'),
  );
  assert.equal(invoked, false);
  assert.equal(store.createRun('idempotent-run', initialInput).revision, 1);
});

test('run fence holds the existing lock without publishing a revision', () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('fenced-run', { status: 'ready' });
  let invoked = 0;
  const result = store.withRunFence('fenced-run', 0, (state) => {
    invoked += 1;
    assert.equal(Object.isFrozen(state), true);
    assert.equal(store.inspectLock('fenced-run').status, 'live');
    return state.status;
  });
  assert.equal(result, 'ready');
  assert.equal(invoked, 1);
  assert.equal(store.readRun('fenced-run').revision, 0);
  assert.throws(
    () => store.withRunFence('fenced-run', 1, () => (invoked += 1)),
    assertCode('CAS_CONFLICT'),
  );
  assert.throws(
    () => store.withRunFence('fenced-run', 0, async () => 'invalid'),
    assertCode('INVALID_FENCE'),
  );
  assert.equal(invoked, 1);
});

test('two process writers produce one committed CAS winner', async () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('concurrent-run', { status: 'ready' });

  const results = await Promise.all([
    childUpdate(root, 'concurrent-run'),
    childUpdate(root, 'concurrent-run'),
  ]);
  assert.equal(results.filter((result) => result.status === 0 && result.stdout === 'ok').length, 1);
  const loser = results.find((result) => result.status !== 0);
  assert.ok(['CAS_CONFLICT', 'RUN_LOCKED'].includes(loser?.stdout), loser?.stderr);
  assert.equal(store.readRun('concurrent-run').revision, 1);
  assert.equal(store.history('concurrent-run').length, 2);
});

test('content-addressed objects are idempotent and detect receipt tampering', () => {
  const root = fixture();
  const store = new GraphStore(root);
  const receipt = {
    runId: 'receipt-run',
    action: 'review',
    evidence: { summary: 'safe summary' },
  };
  const hash = store.putObject('receipts', receipt);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(store.putObject('receipts', receipt), hash);
  assert.deepEqual(store.readObject('receipts', hash), receipt);
  assert.equal(lstatSync(objectFile(root, 'receipts', hash)).mode & 0o077, 0);

  writeFileSync(
    objectFile(root, 'receipts', hash),
    `${canonicalJson({ version: 1, kind: 'receipts', hash, data: { changed: true } })}\n`,
    { mode: 0o600 },
  );
  assert.throws(() => store.readObject('receipts', hash), assertCode('OBJECT_TAMPERED'));
});

test('rejects traversal, unknown kinds, hardlinks and public persistent files', () => {
  const root = fixture();
  const store = new GraphStore(root);
  const hash = store.putObject('tasks', { taskId: 'safe-task' });
  const file = objectFile(root, 'tasks', hash);

  assert.throws(() => store.readObject('../tasks', hash), assertCode('INVALID_STORE_KIND'));
  assert.throws(() => store.readObject('tasks', `../${hash}`), assertCode('INVALID_HASH'));
  assert.throws(() => store.readRun('../bad-run'), assertCode('INVALID_RUN_ID'));

  const alias = `${file}.alias`;
  linkSync(file, alias);
  assert.throws(() => store.readObject('tasks', hash), assertCode('OBJECT_TAMPERED'));
  unlinkSync(alias);
  chmodSync(file, 0o644);
  assert.throws(() => store.readObject('tasks', hash), assertCode('INSECURE_STORE'));
});

test('rejects raw logs, prompt fields and secret material before persistence', () => {
  const root = fixture();
  const store = new GraphStore(root);

  assert.throws(
    () => store.createRun('sensitive-run', { status: 'draft', stdout: 'raw output' }),
    assertCode('SENSITIVE_STORE_DATA'),
  );
  assert.throws(
    () => store.putObject('plans', { prompt: 'send repository source' }),
    assertCode('SENSITIVE_STORE_DATA'),
  );
  assert.throws(
    () =>
      store.putObject('artifacts', {
        body: '-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----',
      }),
    assertCode('SENSITIVE_STORE_DATA'),
  );
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
});

test('enforces plain JSON, run invariants and bounded history queries', () => {
  const root = fixture();
  const store = new GraphStore(root);
  assert.throws(
    () => store.createRun('wrong-id-run', { runId: 'another-run', status: 'draft' }),
    assertCode('STATE_INVARIANT'),
  );
  assert.throws(
    () => store.createRun('class-run', new (class State {})()),
    assertCode('INVALID_STORE_DATA'),
  );
  store.createRun('bounded-run', { status: 'draft' });
  assert.throws(
    () => store.updateRun('bounded-run', 0, async (state) => state),
    assertCode('INVALID_UPDATER'),
  );
  assert.throws(
    () => store.updateRun('bounded-run', 0, () => ({ runId: 'other-run' })),
    assertCode('STATE_INVARIANT'),
  );
  assert.throws(
    () => store.history('bounded-run', { afterRevision: -2 }),
    assertCode('INVALID_HISTORY_QUERY'),
  );
  assert.throws(
    () => store.history('bounded-run', { limit: GRAPH_STORE_LIMITS.maxHistoryLimit + 1 }),
    assertCode('INVALID_HISTORY_QUERY'),
  );
  assert.equal(store.readRun('bounded-run').revision, 0);
});

test('rejects excessive JSON depth and container sizes without creating the store', () => {
  const root = fixture();
  const store = new GraphStore(root);
  let deep = { value: true };
  for (let index = 0; index <= GRAPH_STORE_LIMITS.maxDepth; index += 1) deep = { child: deep };
  assert.throws(() => store.createRun('deep-state-run', deep), assertCode('STORE_LIMIT_EXCEEDED'));
  assert.throws(
    () =>
      store.putObject('artifacts', {
        values: Array.from(
          { length: GRAPH_STORE_LIMITS.maxContainerEntries + 1 },
          (_, index) => index,
        ),
      }),
    assertCode('STORE_LIMIT_EXCEEDED'),
  );
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
});

test('durability stages place the revision directory sync before pointer publication', () => {
  const root = fixture();
  const stages = [];
  const store = new GraphStore(root, {
    fault(stage) {
      stages.push(stage);
    },
  });
  store.createRun('ordered-write-run', { status: 'draft' });
  stages.length = 0;
  store.updateRun('ordered-write-run', 0, (state) => ({ ...state, status: 'ready' }));

  assert.ok(
    stages.indexOf('revision.after-file-fsync') < stages.indexOf('revision.after-directory-fsync'),
  );
  assert.ok(
    stages.indexOf('revision.after-directory-fsync') < stages.indexOf('pointer.before-write'),
  );
  assert.ok(stages.indexOf('pointer.after-file-fsync') < stages.indexOf('pointer.before-rename'));
  assert.ok(
    stages.indexOf('pointer.after-rename') < stages.indexOf('pointer.after-directory-fsync'),
  );
});

test('an orphan durable revision never appears in history until pointer commit', () => {
  const root = fixture();
  let injectedStage = null;
  const store = new GraphStore(root, {
    fault(stage) {
      if (stage === injectedStage) throw new Error(`fault:${stage}`);
    },
  });
  store.createRun('orphan-run', { status: 'draft' });

  injectedStage = 'revision.after-directory-fsync';
  assert.throws(
    () => store.updateRun('orphan-run', 0, (state) => ({ ...state, status: 'ready' })),
    /fault:revision\.after-directory-fsync/,
  );
  assert.equal(store.readRun('orphan-run').revision, 0);
  assert.equal(store.history('orphan-run').length, 1);

  injectedStage = null;
  const recovered = store.updateRun('orphan-run', 0, (state) => ({ ...state, status: 'ready' }));
  assert.equal(recovered.revision, 1);
  assert.equal(store.history('orphan-run').length, 2);
});

test('write and pointer faults do not publish a state without its durable revision', () => {
  const root = fixture();
  let injectedStage = null;
  const store = new GraphStore(root, {
    fault(stage) {
      if (stage === injectedStage) throw new Error(`fault:${stage}`);
    },
  });
  store.createRun('fault-run', { step: 0 });

  injectedStage = 'revision.before-write';
  assert.throws(
    () => store.updateRun('fault-run', 0, (state) => ({ ...state, step: 1 })),
    /fault:revision\.before-write/,
  );
  assert.equal(store.readRun('fault-run').revision, 0);

  injectedStage = 'pointer.before-rename';
  assert.throws(
    () => store.updateRun('fault-run', 0, (state) => ({ ...state, step: 1 })),
    /fault:pointer\.before-rename/,
  );
  assert.equal(store.readRun('fault-run').revision, 0);
  assert.equal(store.history('fault-run').length, 1);

  injectedStage = null;
  assert.equal(store.updateRun('fault-run', 0, (state) => ({ ...state, step: 1 })).revision, 1);
});

test('a fault after pointer rename is observable as committed for recovery', () => {
  const root = fixture();
  let injectedStage = null;
  const store = new GraphStore(root, {
    fault(stage) {
      if (stage === injectedStage) throw new Error(`fault:${stage}`);
    },
  });
  store.createRun('uncertain-run', { step: 0 });
  injectedStage = 'pointer.after-rename';

  assert.throws(
    () => store.updateRun('uncertain-run', 0, (state) => ({ ...state, step: 1 })),
    /fault:pointer\.after-rename/,
  );
  assert.deepEqual(store.readRun('uncertain-run'), {
    revision: 1,
    runId: 'uncertain-run',
    step: 1,
  });
});

test('object write faults remain fail-closed and idempotently recoverable', () => {
  const root = fixture();
  let injectedStage = 'object.before-rename';
  const store = new GraphStore(root, {
    fault(stage) {
      if (stage === injectedStage) throw new Error(`fault:${stage}`);
    },
  });
  const data = { operationId: 'safe-operation', phase: 'request' };
  const hash = sha256(canonicalJson(data));

  assert.throws(() => store.putObject('operations', data), /fault:object\.before-rename/);
  assert.throws(() => store.readObject('operations', hash), assertCode('STORE_NOT_FOUND'));
  injectedStage = null;
  assert.equal(store.putObject('operations', data), hash);
  assert.deepEqual(store.readObject('operations', hash), data);
});

test('inspectLock is read-only and recovery removes only a definitely dead writer', () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('lock-run', { status: 'ready' });
  const directory = runDirectory(root, 'lock-run');
  const lockFile = path.join(directory, '.lock');
  const deadLock = {
    version: 1,
    owner: '00000000-0000-4000-8000-000000000000',
    pid: 2_147_483_647,
    processStart: '2026-01-01T00:00:00.000Z',
  };
  writeFileSync(lockFile, `${canonicalJson(deadLock)}\n`, { mode: 0o600 });

  assert.deepEqual(store.inspectLock('lock-run'), { ...deadLock, status: 'dead' });
  assert.deepEqual(store.recoverLock('lock-run'), {
    recovered: true,
    owner: deadLock.owner,
  });
  assert.equal(store.inspectLock('lock-run'), null);

  const liveLock = { ...deadLock, owner: '11111111-1111-4111-8111-111111111111', pid: process.pid };
  writeFileSync(lockFile, `${canonicalJson(liveLock)}\n`, { mode: 0o600 });
  assert.equal(store.inspectLock('lock-run').status, 'live');
  assert.throws(() => store.recoverLock('lock-run'), assertCode('RUN_LOCKED'));
  assert.equal(existsSync(lockFile), true);
});

test('a corrupt lock is never removed blindly', () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('corrupt-lock-run', { status: 'ready' });
  const lockFile = path.join(runDirectory(root, 'corrupt-lock-run'), '.lock');
  writeFileSync(lockFile, '{bad json\n', { mode: 0o600 });

  assert.throws(() => store.inspectLock('corrupt-lock-run'), assertCode('INVALID_LOCK'));
  assert.throws(() => store.recoverLock('corrupt-lock-run'), assertCode('INVALID_LOCK'));
  assert.equal(existsSync(lockFile), true);
});

test('the active lock has a random owner and blocks nested mutation', () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('nested-lock-run', { status: 'ready' });
  let inspected;
  const updated = store.updateRun('nested-lock-run', 0, (state) => {
    inspected = store.inspectLock('nested-lock-run');
    assert.throws(
      () => store.updateRun('nested-lock-run', 0, (nested) => nested),
      assertCode('RUN_LOCKED'),
    );
    return { ...state, status: 'done' };
  });

  assert.equal(inspected.status, 'live');
  assert.equal(inspected.pid, process.pid);
  assert.match(inspected.owner, /^[a-f0-9-]{36}$/);
  assert.equal(updated.status, 'done');
  assert.equal(store.inspectLock('nested-lock-run'), null);
});

test('store paths reject symlink ancestors and never write through them', () => {
  const root = fixture();
  const outside = fixture();
  symlinkSync(outside, path.join(root, '.ai-orchestrator'));
  const store = new GraphStore(root);

  assert.throws(
    () => store.createRun('linked-store-run', { status: 'draft' }),
    assertCode('INSECURE_STORE'),
  );
  assert.throws(
    () => store.putObject('tasks', { taskId: 'linked-task' }),
    assertCode('INSECURE_STORE'),
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('unreferenced revision files cannot become history events', () => {
  const root = fixture();
  const store = new GraphStore(root);
  store.createRun('orphan-file-run', { status: 'ready' });
  const revisions = path.join(runDirectory(root, 'orphan-file-run'), 'revisions');
  const fakeEnvelope = {
    revision: 1,
    parentHash: '0'.repeat(64),
    state: { revision: 1, runId: 'orphan-file-run', status: 'forged' },
  };
  const fakeHash = sha256(canonicalJson(fakeEnvelope));
  writeFileSync(path.join(revisions, `1-${fakeHash}.json`), `${canonicalJson(fakeEnvelope)}\n`, {
    mode: 0o600,
  });

  assert.deepEqual(
    store.history('orphan-file-run').map((state) => state.revision),
    [0],
  );
  assert.equal(store.readRun('orphan-file-run').status, 'ready');
});

test('commands inside JSON are inert store data', () => {
  const root = fixture();
  const marker = path.join(root, 'must-not-exist');
  const store = new GraphStore(root);
  store.putObject('tasks', {
    taskId: 'inert-task',
    command: `touch ${marker}`,
    argv: ['sh', '-c', `touch ${marker}`],
  });
  assert.equal(existsSync(marker), false);
});

test('revision notifications read only a bounded pointer; full state still rejects chain damage', () => {
  const root = fixture(),
    store = new GraphStore(root),
    runId = 'revision-hint';
  store.createRun(runId, { status: 'pending' });
  store.updateRun(runId, 0, (state) => ({ ...state, status: 'ready' }));
  assert.equal(store.revision(runId), 1);
  const dir = runDirectory(root, runId);
  const first = readdirSync(path.join(dir, 'revisions')).find((name) => name.startsWith('0-'));
  writeFileSync(path.join(dir, 'revisions', first), '{}');
  // A hint is never execution evidence: snapshot/command reads still reject corruption.
  assert.equal(store.revision(runId), 1);
  assert.throws(() => store.readRun(runId), assertCode('STORE_TAMPERED'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ revision: 1, hash: 'bad' }));
  assert.throws(() => store.revision(runId));
});
