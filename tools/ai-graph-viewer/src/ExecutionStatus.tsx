import type { ExecutionPresentation } from './execution-presentation';

export function ExecutionStatus({ value }: { value: ExecutionPresentation }) {
  if (value.kind === 'idle') return null;
  if (value.kind === 'running' || value.kind === 'stopping')
    return (
      <section className={`execution-status ${value.kind === 'stopping' ? 'stop' : 'stage'}`} role="status" aria-live="polite">
        <span className="status-loader-mark" aria-hidden="true" />
        <div>
          <strong>{value.title}</strong>
          <p>{value.description}</p>
        </div>
      </section>
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
