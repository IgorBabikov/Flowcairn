import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedProcess } from './lib/bounded-process.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('waiting for a child leaves the event loop responsive and returns its output', async () => {
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 10);
  const result = await boundedProcess(process.execPath, ['-e', "setTimeout(() => process.stdout.write('ready'), 100)"], { cwd: process.cwd(), timeoutMs: 2000 });
  assert.equal(timerRan, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ready');
});

test('timeout stops a child that ignores SIGTERM before reporting a failure', async () => {
  const start = Date.now();
  await assert.rejects(boundedProcess(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), timeoutMs: 300, timeoutCode: 'SOURCE_CAPTURE_TIMEOUT',
  }), { code: 'SOURCE_CAPTURE_TIMEOUT' });
  assert.ok(Date.now() - start < 3000);
});

test('excessive child output is rejected with bounded memory', async () => {
  await assert.rejects(boundedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], {
    cwd: process.cwd(), timeoutMs: 2000, maxBytes: 100,
  }), { code: 'PROCESS_OUTPUT_LIMIT' });
});

test('timeout stops descendants even when the leader exits and its output pipes close', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const directory = mkdtempSync(path.join(tmpdir(), 'flowcairn-owned-process-'));
  const pidFile = path.join(directory, 'pid');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
  await assert.rejects(boundedProcess(process.execPath, ['-e', script, pidFile], {
    cwd: process.cwd(), timeoutMs: 500,
  }), { code: 'PROCESS_TIMEOUT' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // SIGKILL delivery is asynchronous; allow the kernel to reap the descendant.
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Owned descendant survived timeout');
});
