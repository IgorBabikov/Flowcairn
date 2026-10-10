import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { inspectNativeCursorLearningProfile } from './lib/learning-native-cursor-inspection.mjs';

const script = `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2); if(a[0]==='--version'){console.log('2026.10.01-e373342');process.exit(0)}
if(a[0]==='status'){console.log(fs.readFileSync('status.json','utf8'));process.exit(0)}
if(a[0]==='team'){console.log(fs.readFileSync('teams.json','utf8'));process.exit(0)}
process.exit(2);`;
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fc-cursor-inspection-'))), home = path.join(root, 'home'), profile = path.join(root, 'profile'), work = path.join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(profile, { recursive: true }); mkdirSync(work, { recursive: true });
  const executable = path.join(root, 'agent.mjs');
  writeFileSync(executable, script); chmodSync(executable, 0o700); writeFileSync(path.join(work, 'status.json'), JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { userId: 'user-1' } })); writeFileSync(path.join(work, 'teams.json'), JSON.stringify({ teams: [] }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, profile, work, executable, env: process.env,
    inspect() { return { executable, cwd: work, home, profileRoot: profile, workspaceRoot: work, env: process.env, expectedVersion: '2026.10.01-e373342', platform: 'darwin' }; } };
}
test('inspection is blocked when native policy is not exportable, even with authenticated personal/no-team fixture', t => {
  const f = fixture(t), result = inspectNativeCursorLearningProfile(f.inspect());
  assert.equal(result.status, 'blocked', JSON.stringify(result)); assert.equal(result.canOfferConsent, false); assert.equal(result.reasonCode, 'LEARNING_CURSOR_MANAGED_POLICY_UNVERIFIED');
  assert.ok(result.inspectionHash); assert.equal(result.binding.actions.length, 2); assert.equal(result.binding.accountIdentityHash.length, 64);
  assert.equal(result.binding.executableHash.length, 64); assert.equal(result.binding.selectedClientHash.length, 64); assert.equal(result.binding.toolchainHash.length, 64);
  writeFileSync(path.join(f.work, 'status.json'), JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { userId: 'other-user' } }));
  const changedIdentity = inspectNativeCursorLearningProfile(f.inspect()); assert.notEqual(changedIdentity.binding.accountIdentityHash, result.binding.accountIdentityHash);
});
test('inspection rejects missing identity, team policy, version drift, and unsupported OS without prompt', t => {
  const f = fixture(t);
  for (const status of [{ status: 'unauthenticated', isAuthenticated: false }, { status: 'authenticated', isAuthenticated: true },
    { status: 'authenticated', isAuthenticated: true, userInfo: { email: 'x@example.invalid' } }]) {
    writeFileSync(path.join(f.work, 'status.json'), JSON.stringify(status));
    const result = inspectNativeCursorLearningProfile(f.inspect());
    assert.equal(result.canOfferConsent, false); assert.match(result.reasonCode, /AUTH_REQUIRED|POLICY_UNVERIFIED/);
  }
  writeFileSync(path.join(f.work, 'status.json'), JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { userId: 'u' } }));
  writeFileSync(path.join(f.work, 'teams.json'), JSON.stringify({ teams: [{ id: 1 }] }));
  assert.equal(inspectNativeCursorLearningProfile(f.inspect()).canOfferConsent, false);
  assert.equal(inspectNativeCursorLearningProfile({ ...f.inspect(), expectedVersion: 'wrong' }).reasonCode, 'LEARNING_CURSOR_VERSION_UNVERIFIED');
  assert.equal(inspectNativeCursorLearningProfile({ ...f.inspect(), platform: 'freebsd' }).reasonCode, 'LEARNING_PLATFORM_UNSUPPORTED');
});
