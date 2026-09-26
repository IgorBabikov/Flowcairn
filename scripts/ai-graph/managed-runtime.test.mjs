import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureManagedRuntime, rollbackManagedRuntime, managedProviderExecutable } from './lib/managed-runtime.mjs';

function root(t) {
  const value = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-managed-runtime-')));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return path.join(value, 'runtime');
}
const names = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
const metadata = (provider, version = '9.9.9') => async () => new Response(JSON.stringify({ name: names[provider], version }));
function installer(provider, fail = false) {
  return (_exe, args, options) => {
    if (args.includes('install')) {
      assert.ok(args.includes('--ignore-scripts'));
      assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
      assert.equal(options.env.NODE_OPTIONS, undefined);
      if (fail) return { status: 1 };
      const target = args[args.indexOf('--prefix') + 1];
      const pkg = path.join(target, 'node_modules', names[provider]);
      mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: names[provider], version: '9.9.9' }));
      writeFileSync(path.join(pkg, 'bin', provider === 'codex' ? 'codex.js' : 'claude.exe'), 'fixture');
      if (provider === 'claude') {
        const report = process.platform === 'linux' ? process.report.getReport() : null;
        const suffix = report && !report.header.glibcVersionRuntime ? '-musl' : '';
        const name = `${names[provider]}-${process.platform}-${process.arch}${suffix}`;
        const native = path.join(target, 'node_modules', name);
        mkdirSync(native, { recursive: true });
        writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));
        writeFileSync(path.join(native, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'native fixture');
      }
      return { status: 0 };
    }
    if (args.includes('--version')) return { status: 0, stdout: provider === 'codex' ? 'codex-cli 9.9.9' : '9.9.9 (Claude Code)' };
    return { status: 0, stdout: '--strict-config --ephemeral --output-schema --output-last-message --cd --config --model --permission-profile --print --output-format --permission-mode --tools --strict-mcp-config --no-session-persistence --json-schema --ignore-rules --skip-git-repo-check --json' };
  };
}
for (const provider of ['codex', 'claude']) {
  test(`${provider}: offline preparation does not write or contact registry`, async t => {
    const runtimeRoot = root(t);
    const result = await ensureManagedRuntime(provider, { runtimeRoot, autoUpdate: false, fetcher: () => { throw Error('network forbidden'); } });
    assert.equal(result.available, true);
    assert.equal(existsSync(runtimeRoot), false);
  });
  test(`${provider}: update is prepared for next process; rollback keeps current session stable`, async t => {
    const runtimeRoot = root(t);
    const old = managedProviderExecutable(provider, runtimeRoot);
    const result = await ensureManagedRuntime(provider, { runtimeRoot, fetcher: metadata(provider), spawnSyncImpl: installer(provider) });
    assert.equal(result.updated, true);
    assert.equal(result.executable, old);
    const state = JSON.parse(readFileSync(path.join(runtimeRoot, provider, 'state.json')));
    assert.equal(state.active.version, '9.9.9');
    const fresh = await import(`./lib/managed-runtime.mjs?fresh=${provider}`);
    const updated = fresh.managedProviderExecutable(provider, runtimeRoot);
    assert.ok(updated.includes(state.active.id));
    assert.equal(rollbackManagedRuntime(provider, runtimeRoot).rolledBack, true);
    assert.equal(fresh.managedProviderExecutable(provider, runtimeRoot), updated);
    const next = await import(`./lib/managed-runtime.mjs?rollback=${provider}`);
    assert.equal(next.managedProviderExecutable(provider, runtimeRoot), old);
  });
  test(`${provider}: failed installation keeps fallback and throttles retries`, async t => {
    const runtimeRoot = root(t);
    const first = await ensureManagedRuntime(provider, { runtimeRoot, fetcher: metadata(provider), spawnSyncImpl: installer(provider, true) });
    assert.equal(first.updateError, 'RUNTIME_CANDIDATE_INVALID');
    const next = await ensureManagedRuntime(provider, { runtimeRoot, fetcher: () => { throw Error('should throttle'); } });
    assert.equal(next.updateError, undefined);
    assert.equal(first.executable, next.executable);
  });
}
test('concurrent updater leaves active selection unchanged and does not install twice', async t => {
  const runtimeRoot = root(t); let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = ensureManagedRuntime('codex', { runtimeRoot, fetcher: async () => { await wait; return metadata('codex')(); }, spawnSyncImpl: installer('codex') });
  const second = await ensureManagedRuntime('codex', { runtimeRoot, fetcher: () => { throw Error('must not fetch'); } });
  assert.equal(second.updateError, 'RUNTIME_BUSY_OR_STATE_UNAVAILABLE');
  release(); assert.equal((await first).updated, true);
});

test('tampered runtime bytes fall back to bundled copy on a fresh process', async t => {
  const runtimeRoot = root(t), provider = 'codex';
  const old = managedProviderExecutable(provider, runtimeRoot);
  await ensureManagedRuntime(provider, { runtimeRoot, fetcher: metadata(provider), spawnSyncImpl: installer(provider) });
  const state = JSON.parse(readFileSync(path.join(runtimeRoot, provider, 'state.json')));
  writeFileSync(path.join(runtimeRoot, provider, 'versions', state.active.id, 'node_modules/@openai/codex/bin/codex.js'), 'modified');
  const fresh = await import('./lib/managed-runtime.mjs?tamper');
  assert.equal(fresh.managedProviderExecutable(provider, runtimeRoot), old);
});
test('network failure retains a usable runtime and records a bounded retry time', async t => {
  const runtimeRoot = root(t);
  const result = await ensureManagedRuntime('codex', { runtimeRoot, fetcher: async () => { throw Error('offline'); } });
  assert.equal(result.available, true);
  assert.equal(result.updateError, 'RUNTIME_REGISTRY_UNAVAILABLE');
  const state = JSON.parse(readFileSync(path.join(runtimeRoot, 'codex/state.json')));
  assert.ok(state.checkedAt > 0);
  assert.equal(state.active, undefined);
});
