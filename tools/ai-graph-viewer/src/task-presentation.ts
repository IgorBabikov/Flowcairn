import type { Snapshot } from './contracts';
import type { ExecutionPresentation } from './execution-presentation';
import { runtimeProblem } from './presentation';

const proofLabels = {
  PROVEN: 'Результат подтвержден',
  UNPROVEN: 'Результат пока не подтвержден',
  STALE: 'Нужна повторная проверка',
  FAILED: 'Проверка не пройдена',
  BLOCKED: 'Работа заблокирована',
  RUNNING: 'Работа продолжается',
};

export function taskStatusLabel(snapshot: Snapshot, execution: ExecutionPresentation, unavailable = false): string {
  const failedNode = snapshot.nodes.find(node => node.status === 'failed');
  const failure = runtimeProblem(snapshot.failureReason || failedNode?.reason);
  return unavailable || !snapshot.integrity.valid
    ? 'Состояние недоступно'
    : snapshot.status === 'cancelled'
      ? 'Остановлено пользователем'
    : snapshot.status === 'failed'
      ? failure?.title ?? 'Ошибка выполнения'
    : snapshot.status === 'uncertain' && snapshot.resolutionKind === 'semantic'
      ? 'Нужно уточнение'
    : snapshot.proof
      ? proofLabels[snapshot.proof.status]
      : execution.kind === 'idle'
        ? snapshot.gates.some(gate => gate.type === 'approve-plan') ? 'План ожидает согласования' : 'Подготовка задачи'
        : execution.title;
}
