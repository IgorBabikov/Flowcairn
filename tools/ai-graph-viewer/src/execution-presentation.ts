import type { Snapshot } from './contracts';

export type ExecutionPresentation = {
  kind: 'running' | 'stopping' | 'stopped' | 'stop-uncertain' | 'idle';
  title: string;
  description: string;
  tone: 'info' | 'warning' | 'danger' | 'neutral';
  busy: boolean;
};

const running: ExecutionPresentation = {
  kind: 'running',
  title: 'Работа продолжается',
  description: 'Flowcairn выполняет текущий этап',
  tone: 'info',
  busy: true,
};

const stopping: ExecutionPresentation = {
  kind: 'stopping',
  title: 'Останавливаем процесс…',
  description: 'Дожидаемся безопасного завершения текущей операции',
  tone: 'warning',
  busy: true,
};

export function executionPresentation(
  snapshot: Snapshot | null,
  stopBusy: boolean,
): ExecutionPresentation {
  if (stopBusy) return stopping;
  switch (snapshot?.execution?.state) {
    case 'stopping':
      return stopping;
    case 'stopped':
      return {
        kind: 'stopped',
        title: 'Процесс остановлен',
        description:
          'Текущий результат не подтвержден. Можно продолжить с новым планом или запустить задачу заново',
        tone: 'neutral',
        busy: false,
      };
    case 'stop-uncertain':
      return {
        kind: 'stop-uncertain',
        title: 'Не удалось подтвердить остановку',
        description: 'Процесс мог продолжить работу. Проверьте состояние перед следующим действием',
        tone: 'danger',
        busy: false,
      };
    case 'running':
      return running;
    default:
      return snapshot?.status === 'running'
        ? running
        : {
            kind: 'idle',
            title: '',
            description: '',
            tone: 'neutral',
            busy: false,
          };
  }
}
