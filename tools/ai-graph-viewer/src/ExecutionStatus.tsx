import type { ExecutionPresentation } from './execution-presentation';
import { StatusLoader } from './StatusLoader';

export function ExecutionStatus({ value }: { value: ExecutionPresentation }) {
  if (value.kind === 'idle') return null;
  if (value.kind === 'running' || value.kind === 'stopping')
    return (
      <StatusLoader
        className="execution-status"
        kind={value.kind === 'stopping' ? 'stop' : 'stage'}
        label={`${value.title} ${value.description}`}
      />
    );
  return (
    <section
      className={`execution-status ${value.tone}`}
      role={value.kind === 'stop-uncertain' ? 'alert' : 'status'}
    >
      <span className="execution-status-mark" aria-hidden="true" />
      <div>
        <strong>{value.title}</strong>
        <p>{value.description}</p>
      </div>
    </section>
  );
}
