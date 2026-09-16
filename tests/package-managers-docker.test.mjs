import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeProject } from '../bin/flowcairn.mjs';
import { prepareCheckImage, DOCKER_CHECKS_TESTING } from '../scripts/ai-graph/lib/docker-checks.mjs';
import { sha256 } from '../scripts/ai-graph/lib/io.mjs';

// Explicit networked test: generates real lockfiles and prepares isolated dependency images.
// It never accesses a user project, credentials or an AI provider.
for (const [manager, version] of [['npm', null], ['pnpm', '11.8.0'], ['yarn', '4.9.2']]) {
  test(`real ${manager} lock, Docker preparation and offline workspace script`, { skip: process.env.FLOWCAIRN_DOCKER_TESTS !== '1', timeout: 300000 }, (t) => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-docker-manager-')));
    chmodSync(root, 0o755);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
    const env = DOCKER_CHECKS_TESTING.localDockerEnvironment();
    const docker = (args) => execFileSync(DOCKER_CHECKS_TESTING.dockerExecutable(), args, { env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
    const base = docker(['image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}']).trim();
    const pkg = {
      name: 'flowcairn-check-fixture', version: '1.0.0', private: true,
      ...(version ? { packageManager: `${manager}@${version}` } : {}),
      workspaces: ['packages/*'], dependencies: { 'fixture-app': manager === 'npm' ? 'file:packages/app' : 'workspace:*', ...(manager === 'npm' ? { eslint: '5.16.0' } : {}) },
      ...(manager === 'npm' ? { eslintConfig: { env: { node: true, es6: true } } } : {}),
      scripts: { test: manager === 'npm' ? 'eslint check.cjs && node check.cjs' : 'node check.cjs', postinstall: 'node -e "require(\'fs\').writeFileSync(\'forbidden-hook\',\'ran\')"' },
    };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    mkdirSync(path.join(root, 'packages/app'), { recursive: true });
    writeFileSync(path.join(root, 'packages/app/package.json'), '{"name":"fixture-app","version":"1.0.0","main":"index.cjs"}');
    writeFileSync(path.join(root, 'packages/app/index.cjs'), 'module.exports = 42;');
    writeFileSync(path.join(root, 'check.cjs'), "const a=require('node:assert/strict'),f=require('node:fs'); a.equal(require('fixture-app'),42); a.equal(f.existsSync('forbidden-hook'),false); f.copyFileSync('/bin/busybox','/workspace/busybox'); require('node:child_process').execFileSync('/workspace/busybox',['true']); console.log('WORKSPACE_SCRIPT_AND_NATIVE_BINARY_PASSED');");
    writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.ai-orchestrator/\n.yarn/\n');
    if (manager === 'pnpm') writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    if (manager === 'yarn') writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    const install = manager === 'npm'
      ? 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund'
      : manager === 'pnpm'
        ? `corepack prepare pnpm@${version} --activate && corepack pnpm install --lockfile-only --ignore-scripts`
        : `corepack prepare yarn@${version} --activate && YARN_ENABLE_GLOBAL_CACHE=false corepack yarn install --mode=skip-build`;
    docker(['run', '--rm', '--mount', `type=bind,src=${root},dst=/fixture`, '--workdir', '/fixture', base, '/bin/sh', '-ec', install]);
    assert.equal(existsSync(path.join(root, 'forbidden-hook')), false);
    initializeProject(root, { provider: 'claude', 'provider-path':path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe') });
    const image = prepareCheckImage({ root });
    const sources = ['package.json', 'check.cjs', 'packages/app/package.json', 'packages/app/index.cjs'];
    const contract = { version: 4, actionId: 'check-tests', checkScript: 'test', packageManager: manager, timeoutMs: 10000, files: sources.map((relative) => { const bytes = readFileSync(path.join(root, relative)); return { path: relative, size: bytes.length, hash: sha256(bytes), mode: '100644' }; }) };
    writeFileSync(path.join(root, 'contract.json'), JSON.stringify(contract));
    // Use the actual production contract, not a separately maintained approximation.
    const args = DOCKER_CHECKS_TESTING.createArguments({
      input: { worktree: root, action: { id: 'check-tests' } }, image,
      contractFile: path.join(root, 'contract.json'), labels: {},
      name: `flowcairn-install-${manager}-${process.pid}-${Date.now()}`,
    });
    args[0] = 'run'; args.splice(1, 0, '--rm');
    const output = docker(args);
    assert.match(output, /FLOWCAIRN_CHECK_RESULT /);
    const result = JSON.parse(output.trim().split('FLOWCAIRN_CHECK_RESULT ').pop());
    assert.equal(result.exitCode, 0, result.summary ?? output);
    t.diagnostic(`${manager}${version ? '@' + version : ' bundled'}: real lock + skipped lifecycle + offline workspace + native binary${manager === 'npm' ? ' + ESLint 5 binary' : ''} passed with production createArguments`);
  });
}

test('actual Linux tarball init accepts a verified Claude CLI and preserves an existing project', { skip: process.env.FLOWCAIRN_DOCKER_TESTS !== '1', timeout: 300000 }, (t) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-linux-install-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: runtimeRoot, encoding: 'utf8' }));
  const tarball = path.join(directory, packed[0].filename);
  const script = `set -eu
apk add --no-cache git >/dev/null
mkdir /fixture
cd /fixture
git init --initial-branch=main >/dev/null
printf '%s\\n' '{"name":"existing-linux-project","version":"1.0.0","private":true}' > package.json
printf '%s\\n' '# Owner rules' > AGENTS.md
npm install --ignore-scripts --no-audit --no-fund /artifact.tgz >/dev/null
mkdir -p /fixture/node_modules/@anthropic-ai/claude-code/bin
printf '%s\\n' '{"name":"@anthropic-ai/claude-code","version":"2.1.198"}' > /fixture/node_modules/@anthropic-ai/claude-code/package.json
printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--version" ]; then printf "2.1.198 (Claude Code)\\n"; exit 0; fi' 'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf "{\\"loggedIn\\":true}\\n"; exit 0; fi' 'for argument in "$@"; do [ "$argument" = "--help" ] && exit 0; done' 'printf "{\\"structured_output\\":{\\"summary\\":\\"ok\\"}}\\n"' > /fixture/node_modules/@anthropic-ai/claude-code/bin/claude.exe
chmod 700 /fixture/node_modules/@anthropic-ai/claude-code/bin/claude.exe
./node_modules/.bin/flowcairn init --provider claude --provider-path /fixture/node_modules/@anthropic-ai/claude-code/bin/claude.exe --json > /result.json
node -e "const a=require('node:assert/strict'),f=require('node:fs');const r=JSON.parse(f.readFileSync('/result.json'));a.equal(r.result.profile.ai.provider,'claude');a.equal(f.readFileSync('AGENTS.md','utf8'),'# Owner rules\\n');a.equal(JSON.parse(f.readFileSync('package.json')).name,'existing-linux-project');console.log('LINUX_CLAUDE_INIT_PASSED')"
`;
  const output = execFileSync(DOCKER_CHECKS_TESTING.dockerExecutable(), ['run', '--rm', '--mount', `type=bind,src=${tarball},dst=/artifact.tgz,readonly`, 'node:22-alpine', '/bin/sh', '-ec', script], {
    env: DOCKER_CHECKS_TESTING.localDockerEnvironment(), encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.match(output, /LINUX_CLAUDE_INIT_PASSED/);
});

test('npm exec runs a local unpublished tarball outside project dependencies and Docker preparation remains portable', { skip: process.env.FLOWCAIRN_DOCKER_TESTS !== '1', timeout: 300000 }, (t) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-npm-exec-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const packageText = '{"name":"existing-project","version":"1.0.0","scripts":{"test":"node --test"}}\n';
  writeFileSync(path.join(root, 'package.json'), packageText);
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const userConfig = path.join(directory, 'user.npmrc'), globalConfig = path.join(directory, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, npm_config_cache: path.join(directory, 'cache'), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_update_notifier: 'false' };
  const command = (cwd, args) => execFileSync(process.execPath, [npm, ...args], { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  command(root, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  const lock = readFileSync(path.join(root, 'package-lock.json'));
  const packed = JSON.parse(command(fileURLToPath(new URL('..', import.meta.url)), ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
  const tarball = path.join(directory, packed[0].filename);
  const output = command(root, ['exec', '--yes', '--ignore-scripts', '--package', tarball, '--', 'flowcairn', 'init', '--model', 'fixture-model', '--json']);
  assert.equal(JSON.parse(output).result.created, true);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), packageText);
  assert.deepEqual(readFileSync(path.join(root, 'package-lock.json')), lock);
  assert.equal(existsSync(path.join(root, 'node_modules/flowcairn')), false);
  assert.match(prepareCheckImage({ root }).imageId, /^sha256:/);
});
