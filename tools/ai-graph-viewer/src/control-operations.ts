import type { api } from './api';
import type { IntakeInput, GenerateLesson, AskLesson, SetLearningProgress } from './contracts';

export type PendingControlOperation = {
  kind: 'control';
  key: string;
  operationId: string;
  runId: string;
  action: string;
  request: Parameters<typeof api.control>[2];
};
export type PendingCreateOperation = {
  kind: 'create';
  key: 'create';
  operationId: string;
  input: IntakeInput;
};
type LearningOperationBase = { kind: 'learning'; key: string; operationId: string; runId: string };
export type PendingLearningOperation = LearningOperationBase & (
  | { action: 'generate-lesson'; request: GenerateLesson }
  | { action: 'ask-lesson'; request: AskLesson }
  | { action: 'set-progress'; request: SetLearningProgress }
);
export type LearningActivity = {
  runId: string; jobId: string; materialHash: string; kind: 'lesson' | 'question';
  question?: Pick<AskLesson, 'lessonHash' | 'anchor' | 'question'>;
};
export type PendingOperation = PendingControlOperation | PendingCreateOperation | PendingLearningOperation;
export function operationId(prefix = 'ui'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
