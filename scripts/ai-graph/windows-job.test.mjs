import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, linkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashObject, sha256 } from './lib/io.mjs';
import { prepareWindowsJob, WINDOWS_JOB_TESTING } from './lib/windows-job.mjs';

function fixture(t) { const root = mkdtempSync(path.join(tmpdir(), 'flowcairn-job-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('job preparation is unavailable without the trusted compiler, no direct fallback', () => {
  assert.throws(() => prepareWindowsJob({ executable: process.execPath, args: [] }, { platform: 'win32', findCompiler: () => { throw Error('absent'); } }), { code: 'WINDOWS_JOB_UNAVAILABLE' });
});

test('compiled helper identity rejects executable mutation and incomplete proof', (t) => {
  const root = fixture(t);
  const helper = prepareWindowsJob({ executable: process.execPath, args: [''] }, {
    platform: 'win32', parent: root, findCompiler: () => 'test-compiler', run: (_file, args, config) => {
      assert.equal(config.shell, false);
      writeFileSync(args.find((arg) => arg.startsWith('/out:')).slice(5), 'MZfixture');
      return { status: 0 };
    },
  });
  t.after(() => helper.dispose());
  assert.equal(helper.readCompletion(), null);
  helper.verify();
  writeFileSync(helper.command.executable, 'MZchanged');
  assert.throws(() => helper.verify(), { code: 'WINDOWS_JOB_UNAVAILABLE' });
});

test('native Windows job reaps detached descendants after action exit and preserves argv', { skip: process.platform !== 'win32', timeout: 60000 }, (t) => {
  const root = fixture(t), pidFile = path.join(root, 'child.pid');
  const script = path.join(root, 'action.cjs');
  writeFileSync(script, `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[2],String(child.pid)); child.unref(); process.stdout.write(JSON.stringify(process.argv.slice(3)));`);
  const values = ['', 'two words', 'quote"inside', 'trailing\\', 'юникод'];
  const helper = prepareWindowsJob({ executable: process.execPath, args: [script, pidFile, ...values], cwd: root, env: process.env });
  t.after(() => helper.dispose()); helper.verify();
  const result = spawnSync(helper.command.executable, helper.command.args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
  assert.equal(helper.readCompletion()?.reaped, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('native Windows failed job assignment never resumes the suspended action', { skip: process.platform !== 'win32', timeout: 60000 }, (t) => {
  const root = fixture(t), marker = path.join(root, 'forbidden.txt');
  const helper = prepareWindowsJob({ executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"ran")', marker] }, {
    parent: root,
    run: (compiler, args, options) => {
      const source = args.at(-1);
      writeFileSync(source, readFileSync(source, 'utf8').replace('AssignProcessToJobObject(job, child.Process)', 'AssignProcessToJobObject(IntPtr.Zero, child.Process)'));
      return spawnSync(compiler, args, options);
    },
  });
  t.after(() => helper.dispose());
  const result = spawnSync(helper.command.executable, helper.command.args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 125);
  assert.equal(existsSync(marker), false);
  assert.equal(helper.readCompletion(), null);
});


test('native Windows supervisor timeout persists reaped proof and removes launcher after verified stop', { skip: process.platform !== 'win32', timeout: 90000 }, async (t) => {
  const root = fixture(t), ticketFile = path.join(root, 'ticket.json'), pidFile = path.join(root, 'child.pid');
  const actionFile = path.join(root, 'long-action.cjs');
  writeFileSync(actionFile, `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[2],String(child.pid)); child.unref(); setInterval(()=>{},1000);`);
  const command = { executable: process.execPath, args: [actionFile, pidFile], cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof value === 'string').map(([key, value]) => [key.toUpperCase(), value])) };
  const nonce = 'timeout-proof-fixture';
  writeFileSync(ticketFile, JSON.stringify({ version: 1, state: 'reserved', nonceHash: sha256(nonce), commandHash: hashObject(command), timeoutMs: 1000, maxOutputBytes: 1024, actionId: 'check-tests' }), { mode: 0o600 });
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./lib/supervisor.mjs', import.meta.url)), ticketFile], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill(); });
  let control = '';
  supervisor.stdio[3].on('data', (chunk) => {
    control += chunk.toString();
    for (let newline; (newline = control.indexOf('\n')) >= 0;) {
      const event = JSON.parse(control.slice(0, newline)); control = control.slice(newline + 1);
      if (event.type === 'ready') supervisor.stdin.write(JSON.stringify({ type: 'go', nonce, command, input: '' }) + '\n');
    }
  });
  await new Promise((resolve, reject) => { supervisor.once('error', reject); supervisor.once('close', resolve); });
  const ticket = JSON.parse(readFileSync(ticketFile, 'utf8'));
  assert.equal(ticket.state, 'finished');
  assert.equal(ticket.failureReason, 'TIMEOUT');
  assert.equal(ticket.windowsJobBound, true);
  assert.equal(ticket.windowsJobReaped, true);
  assert.equal(ticket.windowsJobStopMethod, 'verified-job-close');
  assert.equal(existsSync(ticket.actionIdentity.executable), false);
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});


test('trusted fixed Windows compiler accepts OS hardlinks but refuses redirect or symlink', () => {
  const compiler = WINDOWS_JOB_TESTING.compiler;
  const base = { system: 'C:\\Windows', statFile: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 3 }), canonical: (file) => file };
  assert.equal(compiler(base), 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  for (const patch of [
    { canonical: () => 'C:\\untrusted\\csc.exe' },
    { statFile: () => ({ isFile: () => true, isSymbolicLink: () => true, nlink: 1 }) },
  ]) {
    assert.throws(() => compiler({ ...base, ...patch }), (error) => {
      assert.equal(error.code, 'WINDOWS_JOB_UNAVAILABLE');
      assert.equal(error.details.stage, 'compiler-discovery');
      assert.equal(error.details.candidates.length, 2);
      assert.doesNotMatch(JSON.stringify(error.details), /untrusted|Windows/);
      return true;
    });
  }
});

test('OS compiler exception does not permit hardlinked generated helper', (t) => {
  const root = fixture(t);
  assert.throws(() => prepareWindowsJob({ executable: process.execPath, args: [] }, {
    platform: 'win32', parent: root, findCompiler: () => 'test-compiler', run: (_file, args) => {
      const output = args.find((arg) => arg.startsWith('/out:')).slice(5);
      writeFileSync(output, 'MZfixture');
      linkSync(output, path.join(root, 'linked-helper.exe'));
      return { status: 0 };
    },
  }), { code: 'WINDOWS_JOB_UNAVAILABLE', details: { stage: 'generated-file-validation' } });
});

test('compiler failures preserve bounded stage diagnostics without compiler output', () => {
  assert.throws(() => prepareWindowsJob({ executable: process.execPath, args: [] }, {
    platform: 'win32', findCompiler: () => 'test-compiler', run: () => ({ status: 1, stdout: 'private-source-and-credentials', stderr: 'private-path' }),
  }), (error) => {
    assert.equal(error.details.stage, 'compile');
    assert.equal(error.details.status, 1);
    assert.doesNotMatch(JSON.stringify(error), /private-/);
    return true;
  });
});
