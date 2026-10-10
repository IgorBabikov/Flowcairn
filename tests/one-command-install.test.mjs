import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactRegistry, fixtureProvider, freePort, installedRuntime, readTrace, record, redact, run, start, tracePreload } from './fixtures/one-command-install.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const tarball = process.env.FLOWCAIRN_INSTALL_TARBALL;
const evidence = process.env.FLOWCAIRN_INSTALL_EVIDENCE_DIR;
const npmClients = JSON.parse(process.env.FLOWCAIRN_NPM_CLIS ?? JSON.stringify([path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]));
const unsupportedNodes = JSON.parse(process.env.FLOWCAIRN_UNSUPPORTED_NODES ?? '[]');
const namedPackage = process.env.FLOWCAIRN_INSTALL_NAMED_PACKAGE === '1';
const digest = value => createHash('sha256').update(value).digest('hex');
const protectedFiles = root => Object.fromEntries(['AGENTS.md', 'package.json', 'src/value.py'].filter(file => existsSync(path.join(root, file)))
  .map(file => [file, digest(readFileSync(path.join(root, file)))]));

test('real unsupported Node receives an actionable diagnostic before runtime imports', { skip: !unsupportedNodes.length && 'Set FLOWCAIRN_UNSUPPORTED_NODES to actual installed Node executables' }, () => {
  for (const executable of unsupportedNodes) {
    const version = run(executable, ['--version']);
    assert.equal(version.status, 0);
    assert.notEqual(Number(version.stdout.trim().slice(1).split('.')[0]), 22);
    const result = run(executable, [path.join(repository, 'bin/flowcairn.mjs'), '--no-open']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'NODE_VERSION');
    assert.match(JSON.parse(result.stderr).error.message, /Node.js 22/);
    assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|SyntaxError|\n\s+at /);
    record(evidence, `node-${version.stdout.trim()}.json`, { version: version.stdout.trim(), status: result.status, stdout: result.stdout, stderr: result.stderr });
  }
});

for (const npmCli of npmClients) {
  test(`fresh npx cache opens the actual tarball from a separate project (${npmCli})`, {
    skip: !tarball && 'Network integration: set FLOWCAIRN_INSTALL_TARBALL to the reviewed local npm tarball', timeout: 300_000,
  }, async t => {
    const version = run(process.execPath, [npmCli, '--version']);
    assert.equal(version.status, 0, version.stderr);
    const npmVersion = version.stdout.trim();
    assert.ok([8, 10].includes(Number(npmVersion.split('.')[0])), `This gate verifies npm8/10, received ${npmVersion}`);
    const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-one-command-')));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const cache = path.join(fixture, 'empty-npm-cache'), home = path.join(fixture, 'home'), project = path.join(fixture, 'python-project');
    for (const folder of [cache, home, project, path.join(project, 'src')]) mkdirSync(folder, { recursive: true });
    const config = path.join(fixture, 'npmrc'), globalConfig = path.join(fixture, 'global-npmrc');
    writeFileSync(config, ''); writeFileSync(globalConfig, '');
    writeFileSync(path.join(project, 'AGENTS.md'), '# Owner rules\nKeep this file exactly as it is.\n');
    writeFileSync(path.join(project, 'src/value.py'), 'def value():\n    return 42\n');
    // npm exec may inspect this manifest, but must not install into the project
    // or run its lifecycle. Its source language is still Python and Git is absent.
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'owner-project', version: '1.0.0',
      scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('owner-hook-ran','bad')\"" } }));
    const before = protectedFiles(project), provider = fixtureProvider(path.join(fixture, 'fixture-bin'));
    const preload = path.join(fixture, 'observe-cli.cjs'); tracePreload(preload);
    const manifest = JSON.parse(readFileSync(process.env.FLOWCAIRN_PACKED_PACKAGE_JSON ?? path.join(repository, 'package.json')));
    const registry = namedPackage ? await artifactRegistry(tarball, manifest) : null;
    if (registry) t.after(() => registry.close());
    const env = {
      PATH: [path.dirname(provider.executable), path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
      HOME: home, USERPROFILE: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, TEMP: fixture, TMP: fixture, APPDATA: home, LOCALAPPDATA: home } : {}),
      npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_update_notifier: 'false',
      npm_config_registry: registry?.url ?? 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    };
    const npxCli = path.join(path.dirname(npmCli), 'npx-cli.js');
    assert.ok(existsSync(npxCli));
    const packageSpec = namedPackage ? `${manifest.name}@${manifest.version}` : path.resolve(tarball);
    const prefix = ['--yes', '--cache', cache, ...(namedPackage ? [packageSpec] : [`--package=${packageSpec}`, 'flowcairn'])];
    const firstPort = await freePort(), trace = path.join(fixture, 'first.trace.jsonl');
    assert.deepEqual(readdirSync(cache), []);
    assert.equal(existsSync(path.join(project, 'node_modules')), false);
    const terminalOnFirstCall = process.platform !== 'win32';
    const first = await start(process.execPath, [npxCli, ...prefix,
      ...(terminalOnFirstCall ? [] : ['--provider', 'cursor', '--provider-path', provider.executable, '--read-consent']),
      '--skills', 'none', '--no-open', '--port', String(firstPort)],
    { cwd: project, env: { ...env, FLOWCAIRN_INSTALL_TRACE: trace }, trace, interactive: terminalOnFirstCall, evidence, name: `npm-${npmVersion}-fresh` });
    let runtime;
    try {
      const url = `http://127.0.0.1:${firstPort}`;
      assert.equal((await fetch(url)).status, 200);
      assert.match(await (await fetch(url)).text(), /<html/i);
      for (const asset of ['/app.js', '/app.css']) assert.equal((await fetch(url + asset)).status, 200);
      assert.equal((await fetch(url + '/api/project')).status, 403);
      const response = await fetch(url + '/api/project', { headers: { 'x-flowcairn-control': first.token } });
      assert.equal(response.status, 200);
      const summary = await response.json();
      assert.equal(summary.name, path.basename(project));
      const onboarding = await (await fetch(url + '/api/onboarding', { headers: { 'x-flowcairn-control': first.token } })).json();
      assert.equal(onboarding.configured, true);
      assert.equal(onboarding.values.provider, 'cursor');
      if (terminalOnFirstCall) for (const step of [1, 2, 3, 4]) assert.match(first.transcript(), new RegExp(`Шаг ${step} из 4`));
      else t.diagnostic('Native Windows interactive terminal acceptance remains unverified; this run checks noninteractive startup only');
      runtime = installedRuntime(cache);
      assert.ok(runtime);
      const installedPackage = JSON.parse(readFileSync(path.join(runtime, 'package.json')));
      assert.equal(installedPackage.name, manifest.name);
      assert.equal(installedPackage.version, manifest.version);
      assert.deepEqual(installedPackage.dependencies, manifest.dependencies);
      if (registry) { assert.ok(registry.counts.metadata > 0); assert.ok(registry.counts.tarball > 0); }
      const cli = readTrace(trace).find(item => item.event === 'cli');
      assert.equal(realpathSync(cli.runtimeRoot), realpathSync(runtime));
      assert.equal(realpathSync(cli.projectRoot), project);
      assert.notEqual(realpathSync(runtime), project);
      assert.equal(readTrace(trace).some(item => item.event === 'browser'), false);
      assert.deepEqual(protectedFiles(project), before);
      for (const file of ['node_modules', 'package-lock.json', 'owner-hook-ran', '.git', 'bin', 'scripts', 'skills']) assert.equal(existsSync(path.join(project, file)), false, file);
      record(evidence, `npm-${npmVersion}-artifact.json`, { node: process.versions.node, platform: process.platform, arch: process.arch,
        npm: npmVersion, tarballSha256: digest(readFileSync(tarball)), runtimeRoot: runtime, projectRoot: project,
        protectedBefore: before, protectedAfter: protectedFiles(project), cacheWasEmpty: true, browserOpened: false, nativeInference: false,
        terminalOnFirstCall, packageResolution: namedPackage ? 'name/version via loopback artifact registry; dependencies from official registry' : 'explicit local --package tarball',
        registryCounts: registry?.counts ?? null, auth: 'controlled Cursor fixture' });
    } finally { await first.stop(); }
    if (evidence) assert.ok(!readFileSync(path.join(evidence, `npm-${npmVersion}-fresh.stdout.log`), 'utf8').includes(first.token), 'Evidence must redact the local session token');
    const profileBefore = readFileSync(path.join(project, '.flowcairn.json'));
    const repeatPort = await freePort(), repeatTrace = path.join(fixture, 'repeat.trace.jsonl');
    const repeated = await start(process.execPath, [npmCli, 'exec', '--offline', '--yes', '--cache', cache, `--package=${packageSpec}`, '--', 'flowcairn', '--no-open', '--port', String(repeatPort)],
      { cwd: project, env: { ...env, FLOWCAIRN_INSTALL_TRACE: repeatTrace }, trace: repeatTrace, evidence, name: `npm-${npmVersion}-repeat` });
    try { assert.equal((await fetch(`http://127.0.0.1:${repeatPort}`)).status, 200); }
    finally { await repeated.stop(); }
    assert.deepEqual(readFileSync(path.join(project, '.flowcairn.json')), profileBefore);
    assert.deepEqual(protectedFiles(project), before);
    for (const executable of unsupportedNodes) {
      const result = run(executable, [path.join(runtime, 'bin/flowcairn.mjs'), '--no-open'], { cwd: project, env });
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stderr).error.code, 'NODE_VERSION');
    }
    for (const executable of ['@openai/codex/bin/codex.js', '@anthropic-ai/claude-code/bin/claude.exe']) {
      const entry = path.join(path.dirname(runtime), executable);
      const result = executable.endsWith('.js') ? run(process.execPath, [entry, '--version'], { cwd: fixture, env }) : run(entry, ['--version'], { cwd: fixture, env });
      assert.equal(result.status, 0, redact(result.stderr));
      record(evidence, `npm-${npmVersion}-${executable.startsWith('@openai') ? 'codex' : 'claude'}-native-version.json`, { status: result.status, stdout: result.stdout, stderr: result.stderr });
    }
    const conflict = path.join(fixture, 'conflict-project'); mkdirSync(path.join(conflict, '.ai-orchestrator'), { recursive: true });
    writeFileSync(path.join(conflict, '.ai-orchestrator/owner.txt'), 'foreign state');
    const denied = run(process.execPath, [npxCli, '--offline', ...prefix, 'init', '--provider', 'cursor', '--provider-path', provider.executable, '--json'], { cwd: conflict, env });
    assert.equal(denied.status, 2);
    assert.equal(JSON.parse(denied.stderr).error.code, 'INSTALL_CONFLICT');
    assert.equal(readFileSync(path.join(conflict, '.ai-orchestrator/owner.txt'), 'utf8'), 'foreign state');
    assert.equal(existsSync(path.join(conflict, '.flowcairn.json')), false);
    record(evidence, `npm-${npmVersion}-conflict.json`, { status: denied.status, stdout: denied.stdout, stderr: denied.stderr });
    const plain = path.join(fixture, 'no-manifest-project'); mkdirSync(plain);
    writeFileSync(path.join(plain, 'main.py'), 'print(42)\n');
    const plainPort = await freePort(), plainTrace = path.join(fixture, 'plain.trace.jsonl');
    const plainRun = await start(process.execPath, [npxCli, ...prefix, '--provider', 'cursor', '--provider-path', provider.executable,
      '--read-consent', '--skills', 'none', '--no-open', '--port', String(plainPort)],
      { cwd: plain, env: { ...env, FLOWCAIRN_INSTALL_TRACE: plainTrace }, trace: plainTrace, evidence, name: `npm-${npmVersion}-no-manifest` });
    try { assert.equal((await fetch(`http://127.0.0.1:${plainPort}`)).status, 200); }
    finally { await plainRun.stop(); }
    assert.equal(readFileSync(path.join(plain, 'main.py'), 'utf8'), 'print(42)\n');
    assert.equal(existsSync(path.join(plain, 'package.json')), false);
    assert.equal(existsSync(path.join(plain, '.git')), false);
    const probes = readFileSync(provider.probeLog, 'utf8');
    assert.doesNotMatch(probes, /login|--print|--prompt/);
    record(evidence, `npm-${npmVersion}-fixture-probes.log`, probes);
  });
}
