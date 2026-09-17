import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAnalysisEvidence } from './lib/analysis-evidence.mjs';

const artifact = (fact, verdict = 'pass', findings = []) => ({ kind: 'analysis', mediaType: 'application/json', content: JSON.stringify({
  summary: fact, verdict, findings, skillsUsed: [], changedFiles: [], edits: [], plan: [],
  analysis: { requirements: ['Required result'], constraints: [fact], projectFacts: [{ path: 'src/value.mjs', fact }], acceptance: ['Required result'], risks: [] },
}) });

function fixture() {
  const artifacts = { older: artifact('Older fact'), newer: artifact('Newer fact'), failed: artifact('Failed fact', 'fail'),
    blocked: artifact('Blocked fact', 'pass', [{ severity: 'blocking', message: 'Incomplete analysis', path: null }]),
    malformed: { kind: 'analysis', mediaType: 'application/json', content: '{invalid' } };
  return { state: { nodes: {}, planningArtifacts: ['older', 'newer', 'failed', 'blocked', 'malformed'] },
    plan: { nodes: [] }, readArtifact: (id) => artifacts[id], readReceipt: () => ({}) };
}

test('immutable analysis pointer precedes unrelated retained artifacts', () => {
  const input = fixture();
  input.plan.analysisArtifact = 'older';
  const result = selectAnalysisEvidence(input);
  assert.equal(result.artifactId, 'older');
  assert.equal(result.result.analysis.projectFacts[0].fact, 'Older fact');
});

test('retained fallback chooses the latest valid successful analysis and skips failed or malformed claims', () => {
  const result = selectAnalysisEvidence(fixture());
  assert.equal(result.artifactId, 'newer');
  assert.equal(result.result.analysis.projectFacts[0].fact, 'Newer fact');
});

test('a current analyzer without valid completion proof cannot fall back to older facts', () => {
  const input = fixture();
  input.plan.nodes = [{ id: 'analyze', action: { id: 'ai-analyze' } }];
  input.plan.analysisArtifact = 'older';
  input.state.nodes = { analyze: { status: 'passed', receipts: ['invalid-receipt'] } };
  assert.equal(selectAnalysisEvidence(input), null);
});
