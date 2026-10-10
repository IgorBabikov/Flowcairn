import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { probeExternalProvider } from './lib/providers.mjs';

// Real Cursor 2026.10.01-e373342 returns exit 0 for an unauthenticated status.
// These fixtures exercise the status protocol, not a live account/model call.
function cursorFixture(t, report, exitCode = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-cursor-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'cursor-agent');
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if(args[0] === '--version') console.log('2026.10.01-e373342');
else if(args[0] === '--help') console.log('--print --output-format --sandbox --mode');
else if(args[0] === 'status') { require('node:assert/strict').deepEqual(args, ['status','--format','json']); process.stdout.write(${JSON.stringify(report)}); process.exitCode = ${exitCode}; }
else throw new Error('Inference must not run');
`, { mode: 0o700 });
  return executable;
}

test('Cursor exit 0 без авторизации не разрешает передачу проекта', { skip: process.platform === 'win32' }, t => {
  const executable = cursorFixture(t, JSON.stringify({ status: 'unauthenticated', isAuthenticated: false,
    hasAccessToken: false, hasRefreshToken: false, message: 'Synthetic status' }));
  const probe = probeExternalProvider('cursor', { executable });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'PROVIDER_AUTH_REQUIRED');
});

test('Cursor требует явное подтверждение авторизации, а не произвольный успешный stdout', { skip: process.platform === 'win32' }, t => {
  for (const report of ['{}', '{"isAuthenticated":"true"}', 'authenticated', 'not-json']) {
    const probe = probeExternalProvider('cursor', { executable: cursorFixture(t, report) });
    assert.equal(probe.available, false, report);
    assert.equal(probe.reason, 'PROVIDER_AUTH_REQUIRED');
  }
});

test('Cursor принимает положительный JSON status только при успешном завершении команды', { skip: process.platform === 'win32' }, t => {
  assert.equal(probeExternalProvider('cursor', { executable: cursorFixture(t, '{"isAuthenticated":true}') }).available, true);
  assert.equal(probeExternalProvider('cursor', { executable: cursorFixture(t, '{"isAuthenticated":true}', 1) }).available, false);
});
