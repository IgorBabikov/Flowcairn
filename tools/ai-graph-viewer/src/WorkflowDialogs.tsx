import { operationId,type PendingControlOperation } from './control-operations';
import { DraftDialog,EvidenceDialog,GateDialog } from './ExecutionDialogs';
import { ModalSurface } from './ModalSurface';
import { humanText } from './presentation';
import { SetupPanel } from './SetupPanel';
import { getCapability } from './ui-controls';

import type { WorkflowController } from './workflow-controller-types';
export function WorkflowDialogs({ controller }: { controller: WorkflowController }) {
 const { locale, labels, snapshot, plan, setNotice, busy, evidence, setEvidence, showSetup, setShowSetup, showDraft, setShowDraft, gate, setGate, gateDialog, snapshotRef, sendOperation } = controller;
 return <>
      {showSetup && <ModalSurface title="Настройки проекта" onClose={() => setShowSetup(false)} className="settings-dialog">
        <SetupPanel onClose={() => setShowSetup(false)} />
      </ModalSurface>}
      {showDraft && snapshot && plan && (
        <DraftDialog
          key={`${snapshot.runId}:${snapshot.planHash ?? ''}`}
          locale={locale}
          plan={plan}
          runId={snapshot.runId}
          planHash={snapshot.planHash!}
          expectedRevision={snapshot.revision!}
          busy={busy}
          onClose={() => setShowDraft(false)}
          onSubmit={(nodes, binding) => {
            const current = snapshotRef.current;
            const capability = getCapability(current?.capabilities ?? {}, 'requestReplan');
            if (!capability.allowed)
              return setNotice(humanText(capability.reason, locale) || labels.unavailable);
            const operation: PendingControlOperation = {
              kind: 'control',
              key: `${binding.runId}:replan`,
              operationId: operationId('replan'),
              runId: binding.runId,
              action: 'replan',
              request: {
                operationId: '',
                expectedRevision: binding.expectedRevision,
                planHash: binding.planHash,
                draft: { nodes },
              },
            };
            operation.request.operationId = operation.operationId;
            setShowDraft(false);
            void sendOperation(operation);
          }}
        />
      )}
      <GateDialog
        key={gate?.challenge ?? 'closed-gate'}
        ref={gateDialog}
        gate={gate}
        planNodes={snapshot?.planHash === gate?.planHash ? snapshot?.nodes ?? [] : []}
        locale={locale}
        busy={busy}
        node={gate ? (snapshot?.nodes.find((node) => node.id === gate.nodeId) ?? null) : null}
        onClose={() => {
          gateDialog.current?.close();
          setGate(null);
        }}
        onSubmit={(decision, reason) => {
          if (!snapshot || !gate) return;
          const op = operationId('gate');
          const operation: PendingControlOperation = {
            kind: 'control',
            key: `${snapshot.runId}:gate:${gate.nodeId}:${decision}`,
            operationId: op,
            runId: snapshot.runId,
            action: 'gate',
            request: {
              operationId: op,
              expectedRevision: snapshot.revision!,
              planHash: snapshot.planHash!,
              nodeId: gate.nodeId,
              decision,
              challenge: gate.challenge,
              ...(decision === 'approve' ? { permissions: gate.requiredPermissions } : {}),
              ...(reason ? { reason } : {}),
            },
          };
          gateDialog.current?.close();
          setGate(null);
          void sendOperation(operation);
        }}
      />
      {evidence && (
        <EvidenceDialog evidence={evidence} locale={locale} onClose={() => setEvidence(null)} />
      )}

 </>;
}
