export function TechnicalDetails({
  code,
  message,
}: {
  code?: string | null;
  message?: string | null;
}) {
  if (!code && !message) return null;
  return (
    <details className="technical-details">
      <summary>Технические детали</summary>
      <dl>
        {code && <><dt>Код</dt><dd><code>{code}</code></dd></>}
        {message && <><dt>Сообщение</dt><dd><code>{message}</code></dd></>}
      </dl>
    </details>
  );
}
