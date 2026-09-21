export function StatusLoader({
  kind,
  label,
  inline = false,
  className = '',
  announce = true,
}: {
  kind: 'button' | 'stage' | 'stop';
  label: string;
  inline?: boolean;
  className?: string;
  announce?: boolean;
}) {
  return (
    <span
      className={`status-loader ${kind}${inline ? ' inline' : ''}${className ? ` ${className}` : ''}`}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
    >
      <span className="status-loader-mark" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
