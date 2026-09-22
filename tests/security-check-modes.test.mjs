import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';
import { hasTrustedLocalChecksBinding } from '../scripts/ai-graph/lib/project.mjs';

const testClaude = path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');

test('new projects register conventional scripts in trusted-local without running them during setup', (t) => {
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
  const installed = initializeProject(root, { provider: 'claude', 'provider-path': testClaude });
  assert.deepEqual(installed.profile.checks, ['tests']);
  assert.equal(installed.profile.checkMode, 'trusted-local');
  assert.equal(hasTrustedLocalChecksBinding(root, installed.profile), true);
  assert.equal(existsSync(path.join(root, 'host-code-ran')), false);
});

test('trusted-local binds exact registered scripts and detects later drift', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-trusted-local-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Правила проекта');
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const options = { provider: 'claude', 'provider-path': testClaude, checks: 'tests', 'check-mode': 'trusted-local' };
  const installed = initializeProject(root, options);
  assert.equal(installed.profile.checkMode, 'trusted-local');
  assert.deepEqual(installed.profile.checkScripts, { tests: 'test' });
  assert.equal(hasTrustedLocalChecksBinding(root, installed.profile), true);
  installed.profile.checkScripts.tests = 'changed';
  assert.equal(hasTrustedLocalChecksBinding(root, installed.profile), false);
});
