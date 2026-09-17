import type { api } from './api';
import type { IntakeInput } from './contracts';

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
export type PendingOperation = PendingControlOperation | PendingCreateOperation;
export function operationId(prefix = 'ui'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
