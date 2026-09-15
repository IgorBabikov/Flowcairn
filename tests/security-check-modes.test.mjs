import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';
import { hasTrustedLocalChecksConsent } from '../scripts/ai-graph/lib/project.mjs';

test('new projects do not register or run a repository script without an explicit check boundary', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-security-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'malicious-fixture',
    scripts: { test: "node -e \"require('node:fs').writeFileSync('host-code-ran', 'unexpected')\"" },
  }));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Не исполнять scripts без отдельного разрешения.');
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const installed = initializeProject(root, { provider: 'openai', model: 'fixture-model' });
  assert.deepEqual(installed.profile.checks, []);
  assert.equal(installed.profile.checkMode, 'none');
  assert.equal(existsSync(path.join(root, 'host-code-ran')), false);
});

test('trusted-local requires a separate consent and binds it to registered scripts', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-trusted-local-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Правила проекта');
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const options = { provider: 'openai', model: 'fixture-model', checks: 'tests', 'check-mode': 'trusted-local' };
  assert.throws(() => initializeProject(root, options), { code: 'CHECK_LOCAL_CONSENT' });
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  const installed = initializeProject(root, { ...options, 'trusted-local-consent': true });
  assert.equal(installed.profile.checkMode, 'trusted-local');
  assert.deepEqual(installed.profile.checkScripts, { tests: 'test' });
  assert.equal(hasTrustedLocalChecksConsent(root, installed.profile), true);
  installed.profile.checkScripts.tests = 'changed';
  assert.equal(hasTrustedLocalChecksConsent(root, installed.profile), false);
});
