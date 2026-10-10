import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuildFixture, guildRequest } from './guild-workflow-fixture.mjs';

for (const repair of [false, true]) test(`guild TEST ONLY AI runs actual task/approval/patch/check/${repair ? 'repair/' : ''}review/book receipts`, async t => {
  const f = await createGuildFixture({ repair, dist: fileURLToPath(new URL('../dist', import.meta.url)) }); t.after(() => f.close());
  await f.intake(); let s = await f.settle();
  assert.equal(s.phase, 'execution');
  assert.equal(s.status, 'waiting-for-human', JSON.stringify(s));
  assert.equal(f.counts.implement, 0);
  assert.equal(readFileSync(path.join(f.root, 'counter.json'), 'utf8'), '0\n');
  const gate = s.gates.find(item => item.type === 'approve-plan');
  assert.equal((await fetch(`${f.url}/api/runs/${s.runId}/snapshot`)).status, 403);
  const throughHttp = await fetch(`${f.url}/api/runs/${s.runId}/snapshot`, { headers: { 'x-flowcairn-control': f.token } });
  assert.equal(throughHttp.status, 200); assert.equal((await throughHttp.json()).planHash, s.planHash);
  await assert.rejects(f.service.command(s.runId, 'gate', guildRequest(s, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: 'forged-test-only' })));
  const command = guildRequest(s, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge });
  const approved = await fetch(`${f.url}/api/runs/${s.runId}/control/gate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowcairn-control': f.token }, body: JSON.stringify(command) });
  assert.equal(approved.status, 200); s = await f.settle();
  assert.equal(s.proof.status, 'PROVEN', JSON.stringify({ status: s.status, reason: s.failureReason, nodes: s.nodes, proof: s.proof }));
  assert.equal(f.counts.implement, repair ? 2 : 1);
  assert.ok(f.observations.some(item => item.exitCode === 0 && item.value === '2\n'));
  if (repair) assert.ok(f.observations.some(item => item.exitCode !== 0 && item.value === '1\n'));
  const implement = s.nodes.find(node => node.action.id === 'ai-implement');
  assert.equal(f.service.receipt(s.runId, implement.receiptIds.at(-1)).actionId, 'ai-implement');
  assert.ok(s.proof.certificate.receiptIds.length);
  assert.ok(s.learning.finalMaterialHash);
  const material = f.service.learningMaterial(s.runId, s.learning.finalMaterialHash);
  const source = material.sources.find(item => item.path === 'counter.json' && item.role === 'after');
  assert.equal(f.service.learningSource(s.runId, material.id, source.id).text, '2\n');
  const qa = fileURLToPath(new URL('../../../output/product-completion/rpg/qa', import.meta.url));
  mkdirSync(qa, { recursive: true });
  writeFileSync(path.join(qa, `backend-${repair ? 'repair' : 'success'}.json`), JSON.stringify({ ...f.evidence(), sourceBook: { material, source: f.service.learningSource(s.runId, material.id, source.id) } }, null, 2));
  writeFileSync(path.join(f.root, 'counter.json'), '3\n');
  // The repair chain may retain a blocking predecessor finding => FAILED, not STALE.
  // Both must withhold current completion and certificate after source drift.
  assert.notEqual(f.current().proof.status, 'PROVEN');
  assert.equal(f.current().proof.certificate, null);
});
