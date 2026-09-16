import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildResponsesRequest,
  parseResponsesResult,
  requestResult,
  main,
} from './lib/openai-worker.mjs';
import { RUNNER_TESTING, probeRunner } from './lib/runner.mjs';
import { prepareToolchain, verifyToolchain } from './lib/toolchain.mjs';
import { DOCKER_CHECKS_TESTING } from './lib/docker-checks.mjs';
import { classifyAiFailure } from './lib/supervisor.mjs';
const hash = (body) => createHash('sha256').update(body).digest('hex');
const payload = () => ({
  version: 1,
  model: 'fixture-model',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  prompt: 'Untrusted task',
  source: [],
  reviewEvidence: null,
});
const response = (text = '{}') => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
});
function fixture(t, packageManager = 'npm') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-portable-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = {
    version: 1,
    integrationBranch: 'main',
    packageManager,
    contextPaths: [],
    checks: ['tests'],
    outputPaths: [],
    manifests: ['package.json', packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'],
    ai: { provider: 'openai', model: 'fixture-model' },
  };
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  writeFileSync(
    path.join(root, profile.manifests[1]),
    packageManager === 'npm' ? '{"lockfileVersion":3,"packages":{}}' : 'lockfileVersion: 9\n',
  );
  return { root, profile };
}

test('Responses uses static developer instructions and preserves full review evidence above 128 KiB', () => {
  const content = JSON.stringify({ diff: 'x'.repeat(500000), tail: 'IMPORTANT END' });
  const value = {
    ...payload(),
    reviewEvidence: { content, hash: hash(content), bytes: Buffer.byteLength(content) },
  };
  const request = buildResponsesRequest(value);
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.tools, undefined);
  assert.equal(request.input[0].role, 'developer');
  const sent = JSON.parse(request.input[1].content);
  assert.equal(sent.reviewEvidence.content, content);
  assert.ok(sent.reviewEvidence.content.endsWith('IMPORTANT END"}'));
  assert.equal(sent.reviewEvidence.hash, hash(content));
  assert.throws(
    () =>
      buildResponsesRequest({
        ...value,
        reviewEvidence: { ...value.reviewEvidence, hash: '0'.repeat(64) },
      }),
    /AI_REVIEW_EVIDENCE_INVALID/,
  );
});

test('Responses rejects incomplete, refusal, invalid JSON and ambiguous multi-message output', () => {
  assert.deepEqual(parseResponsesResult(response('{"summary":"ok"}')), { summary: 'ok' });
  assert.throws(
    () => parseResponsesResult({ ...response(), status: 'incomplete' }),
    /AI_RESPONSE_INCOMPLETE/,
  );
  assert.throws(
    () =>
      parseResponsesResult({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal' }] }],
      }),
    /AI_RESPONSE_REFUSED/,
  );
  assert.throws(() => parseResponsesResult(response('not-json')), /AI_RESPONSE_INVALID/);
  const multiple = response();
  multiple.output.push(multiple.output[1]);
  assert.throws(() => parseResponsesResult(multiple), /AI_RESPONSE_INVALID/);
});

test('API transport fixes endpoint, denies redirects, and keeps secret out of request body', async () => {
  const calls = [];
  const result = await requestResult(payload(), {
    apiKey: 'fixture-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response('{"edits":[]}')));
    },
  });
  assert.deepEqual(result, { edits: [] });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-secret');
  assert.ok(!calls[0].init.body.includes('fixture-secret'));
});

test('API failures emit fixed codes and never reflect provider diagnostics', async () => {
  for (const [status, code] of [
    [401, 'AI_AUTH_REQUIRED'],
    [429, 'AI_RATE_LIMIT'],
    [503, 'AI_PROVIDER_UNAVAILABLE'],
    [400, 'AI_REQUEST_REJECTED'],
  ]) {
    await assert.rejects(
      requestResult(payload(), {
        apiKey: 'test',
        fetchImpl: async () => new Response('sensitive provider diagnostic', { status }),
      }),
      new RegExp(code),
    );
    assert.equal(classifyAiFailure(JSON.stringify({ type: 'error', message: code })), code);
  }
  await assert.rejects(
    requestResult(payload(), {
      apiKey: 'test',
      fetchImpl: async () => {
        throw new Error('secret response');
      },
    }),
    /AI_NETWORK_ERROR/,
  );
  await assert.rejects(
    requestResult(payload(), {
      apiKey: 'test',
      fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    }),
    /AI_OUTPUT_LIMIT/,
  );
});

test('flat npm/pnpm project needs no canonical host node_modules and no runtime files in project', (t) => {
  for (const packageManager of ['npm', 'pnpm']) {
    const { root, profile } = fixture(t, packageManager);
    const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'task-1');
    mkdirSync(worktree, { recursive: true });
    const manifest = prepareToolchain({ root, worktree });
    assert.deepEqual(manifest.dependencyPaths, []);
    assert.deepEqual(manifest.readRoots, []);
    assert.deepEqual(verifyToolchain({ root, worktree, manifest }), manifest);
    const context = DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`);
    assert.equal(context.packageManager, packageManager);
    assert.deepEqual(
      context.sources.filter((entry) => entry.projectInput).map((entry) => entry.source),
      profile.manifests,
    );
    assert.ok(
      context.sources
        .find((entry) => entry.target === 'Dockerfile')
        .body.toString()
        .includes('/opt/flowcairn/'),
    );
    writeFileSync(
      path.join(root, 'unrelated.txt'),
      'private source never enters dependency context',
    );
    assert.equal(
      DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`).hash,
      context.hash,
    );
  }
});

test('Docker manifest context refuses additional source files even when profile requests them', (t) => {
  const { root, profile } = fixture(t);
  profile.manifests.push('.env');
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  writeFileSync(path.join(root, '.env'), 'NOT-A-REAL-SECRET');
  assert.throws(
    () => DOCKER_CHECKS_TESTING.contextDescription(root, `sha256:${'a'.repeat(64)}`),
    (error) => ['CHECK_CONTEXT_UNSAFE', 'PROJECT_PROFILE_INVALID'].includes(error.code),
  );
});

test('OpenAI probe is local only and denies nonofficial endpoint even with key present', async (t) => {
  const { root, profile } = fixture(t);
  profile.ai.baseUrl = 'https://example.com/v1';
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  assert.equal((await probeRunner({ root })).ai.reason, 'AI_ENDPOINT_UNSUPPORTED');
});

test('Codex path discovery does not assume Node and CLI share install prefix', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-codex-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.145.0' }),
  );
  const entry = path.join(root, 'bin', 'codex.js');
  writeFileSync(entry, '// test fixture only');
  chmodSync(entry, 0o644);
  assert.equal(RUNNER_TESTING.discoverCodex({ codexPath: entry }).entry, entry);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.154.0' }));
  assert.equal(RUNNER_TESTING.discoverCodex({ codexPath: entry }).manifest.version, '0.154.0');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.1.0' }),
  );
  assert.throws(() => RUNNER_TESTING.discoverCodex({ codexPath: entry }), {
    code: 'RUNNER_TOOLCHAIN_INVALID',
  });
});

test('worker refuses changed private payload before any API call', async (t) => {
  const { root } = fixture(t);
  const input = path.join(root, 'input.json');
  writeFileSync(input, JSON.stringify(payload()), { mode: 0o600 });
  await assert.rejects(
    main(input, path.join(root, 'result.json'), '0'.repeat(64)),
    /AI_INPUT_CHANGED/,
  );
});

test('OpenAI payload uses canonical trailing-slash scope/deny boundaries and complete review evidence', (t) => {
  const { root, profile } = fixture(t);
  for (const args of [
    ['init', '--initial-branch=main'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
  ]) {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/main.js'), 'export const value = 1;');
  mkdirSync(path.join(root, 'src/private'));
  mkdirSync(path.join(root, 'src/private-other'));
  writeFileSync(path.join(root, 'src/private/customer.txt'), 'FORBIDDEN_CUSTOMER_MARKER');
  writeFileSync(path.join(root, 'src/private-other/customer.txt'), 'ALLOWED_NEIGHBOR_MARKER');
  writeFileSync(path.join(root, 'src/.env.example'), 'SENSITIVE_TEMPLATE_MARKER');
  writeFileSync(path.join(root, 'unselected.txt'), 'not in approved context');
  const outputPath = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-ai-output-')));
  chmodSync(outputPath, 0o700);
  t.after(() => rmSync(outputPath, { recursive: true, force: true }));
  const previous = process.env.FLOWCAIRN_OPENAI_API_KEY;
  process.env.FLOWCAIRN_OPENAI_API_KEY = 'fixture-only-key';
  t.after(() => {
    if (previous === undefined) delete process.env.FLOWCAIRN_OPENAI_API_KEY;
    else process.env.FLOWCAIRN_OPENAI_API_KEY = previous;
  });
  const content = JSON.stringify({ fullDiff: 'x'.repeat(300000), tail: 'review-complete' });
  const node = {
    id: 'review',
    action: { id: 'ai-review' },
    resources: { reads: ['src'], writes: [], exclusive: [] },
  };
  const preparation = {
    worktree: root,
    node,
    task: {
      goal: 'Fixture',
      instructions: 'Review',
      scope: ['src'],
      contextPaths: [],
      forbiddenPaths: ['src/private/'],
      acceptance: ['Correct'],
    },
    plan: { nodes: [node] },
    skills: [],
    priorEvidence: null,
    reviewBundle: { content, bytes: Buffer.byteLength(content), hash: hash(content) },
    outputPath,
    toolchain: { node: process.execPath, digest: 'a'.repeat(64) },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) },
    profile,
  };
  for (const readScope of ['src', 'src/']) for (const route of [
    { ai: profile.ai, expected: undefined, model: profile.ai.model },
    { ai: { ...profile.ai, modelMode: 'manual', reasoningEffort: 'low', reviewReasoningEffort: 'high', reviewModel: 'other-model' }, expected: 'low', model: profile.ai.model },
    { ai: { ...profile.ai, modelMode: 'auto', reasoningEffort: 'low', reviewReasoningEffort: 'high', reviewModel: 'other-model' }, expected: 'high', model: 'other-model' },
  ]) {
    const prepared = RUNNER_TESTING.makeOpenAiCommand({
      ...preparation,
      profile: { ...profile, ai: route.ai },
      node: { ...node, resources: { ...node.resources, reads: [readScope] } },
    });
    try {
      const body = readFileSync(prepared.inputFile, 'utf8');
      const input = JSON.parse(body);
      assert.equal(input.reasoningEffort,route.expected);
      assert.equal(input.model,route.model);
      assert.equal(prepared.execution.reasoningEffort,route.expected);
      assert.deepEqual(buildResponsesRequest(input).reasoning,route.expected ? { effort: route.expected } : undefined);
      assert.deepEqual(
        input.source.map((file) => file.path),
        ['src/main.js', 'src/private-other/customer.txt'],
      );
      assert.equal(input.source[0].hash, hash('export const value = 1;'));
      assert.equal(input.reviewEvidence.content, content);
      assert.equal(prepared.command.args.at(-1), hash(body));
      assert.equal(prepared.execution.provider, 'openai');
      assert.equal(prepared.command.env.FLOWCAIRN_OPENAI_API_KEY, 'fixture-only-key');
      assert.ok(!body.includes('fixture-only-key'));
      assert.ok(!body.includes('not in approved context'));
      assert.ok(!body.includes('FORBIDDEN_CUSTOMER_MARKER'));
      assert.ok(!body.includes('SENSITIVE_TEMPLATE_MARKER'));
      assert.ok(body.includes('ALLOWED_NEIGHBOR_MARKER'));
      assert.equal(prepared.input, '');
    } finally {
      RUNNER_TESTING.cleanupPrepared(prepared);
    }
  }
  writeFileSync(path.join(root, 'src/.env'), 'SENSITIVE_ENV_MARKER');
  assert.throws(() => RUNNER_TESTING.makeOpenAiCommand(preparation), {
    code: 'SENSITIVE_WORKSPACE_PATH',
  });
});

// Контракт: https://developers.openai.com/api/docs/guides/reasoning
test('явное усиление передается Responses без подмены и без молчаливого fallback', async () => {
 for (const effort of ['low','medium','high','xhigh']) {
   const request=buildResponsesRequest({...payload(),reasoningEffort:effort});
   assert.deepEqual(request.reasoning,{effort});
 }
 assert.equal(Object.hasOwn(buildResponsesRequest(payload()),'reasoning'),false);
 for(const effort of ['automatic','',null,3])assert.throws(()=>buildResponsesRequest({...payload(),reasoningEffort:effort}),/AI_INPUT_INVALID/);
 let calls=0;
 await assert.rejects(requestResult({...payload(),reasoningEffort:'xhigh'},{apiKey:'fixture',fetchImpl:async(_url,options)=>{
   calls++;assert.deepEqual(JSON.parse(options.body).reasoning,{effort:'xhigh'});return new Response('unsupported effort',{status:400});
 }}),/AI_REQUEST_REJECTED/);
 assert.equal(calls,1,'не повторять запрос с другим effort');
});
