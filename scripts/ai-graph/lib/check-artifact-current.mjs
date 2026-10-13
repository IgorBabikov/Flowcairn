import { GraphError, hashObject } from './io.mjs';
import { boundCheckVerification, hashRegisteredAndroidArtifact } from './check-verification.mjs';
import { boundXCTestMaterialPaths, hashRegisteredXCTestTree } from './xctest-artifact-material.mjs';

const contains = (scope, file) => file === scope || file.startsWith(`${scope}/`);
const fail = () => { throw new GraphError('CHECK_ARTIFACT_DRIFT', 'Проверенный native artifact изменился или недоступен; нужна свежая проверка.'); };

/** Revalidate only new receipt-owned material artifacts for the current source.
 * Historical receipts without artifactPath retain their original meaning.
 * No device/tool invocation or permission changes occur in this read-only guard.
 * @param {{root:string, state:any, plan:any, fingerprint:any, readReceipt:Function}} input
 */
export function verifyCurrentCheckArtifacts({ root, state, plan, fingerprint, readReceipt }) {
  const checked = [];
  if (!fingerprint?.hash) return checked;
  for (const node of plan.nodes) {
    if (!node.action.id.startsWith('check-') || state.nodes[node.id]?.status !== 'passed') continue;
    const id = state.nodes[node.id].receipts.at(-1);
    if (!id) continue;
    const receipt = readReceipt(id);
    if (receipt.beforeFingerprint !== fingerprint.hash || receipt.afterFingerprint !== fingerprint.hash) continue;
    const definition = plan.checks?.definitions.find(entry => `check-${entry.id}` === node.action.id);
    const nativeIosDefinition = definition?.report?.format === 'flowcairn-xctest/v1' && Boolean(definition.report.xctest);
    if (nativeIosDefinition && !receipt.checks?.some(check => check.id === node.id)) fail();
    for (const check of receipt.checks ?? []) {
      const material = check.verification;
      const nativeIos = nativeIosDefinition;
      if (nativeIos && (!material?.artifactPath || !material.applicationArtifactPath ||
          !material.artifactHash || !material.applicationArtifactHash)) fail();
      if (!material?.artifactPath) continue;
      if (hashObject(receipt) !== id || receipt.runId !== state.runId || receipt.planHash !== state.planHash ||
          receipt.nodeId !== node.id || receipt.phase !== 'finished' || receipt.verdict !== 'pass' || receipt.exitCode !== 0 ||
          receipt.termination?.stopped !== true || receipt.termination.uncertain !== false ||
          check.id !== node.id || check.inputHash !== fingerprint.hash || !check.passed ||
          !boundCheckVerification(plan, node, check)) fail();
      if (!definition || !definition.outputPaths.some(scope => contains(scope, material.artifactPath))) fail();
      try {
        if (nativeIos) {
          boundXCTestMaterialPaths(definition, material.artifactPath, material.applicationArtifactPath);
          if (hashRegisteredXCTestTree(root, definition, material.artifactPath) !== material.artifactHash ||
              hashRegisteredXCTestTree(root, definition, material.applicationArtifactPath) !== material.applicationArtifactHash) fail();
        } else {
          if (material.applicationArtifactPath || material.applicationArtifactHash) fail();
          const current = hashRegisteredAndroidArtifact(root, definition.outputPaths, material.artifactPath);
          if (current !== material.artifactHash) fail();
        }
      } catch { fail(); }
      checked.push({ nodeId: node.id, receiptId: id, artifactHash: material.artifactHash,
        ...(nativeIos ? { applicationArtifactHash: material.applicationArtifactHash } : {}) });
    }
  }
  return checked;
}
