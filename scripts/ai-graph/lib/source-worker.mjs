import { captureSourceBundle } from './source.mjs';

// Fixed local worker; no AI, network calls, or project scripts are executed.
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) throw new Error('input limit');
  }
  const { root, storage, allowedUntracked, profile } = JSON.parse(input);
  const result = captureSourceBundle(root, storage, { allowedUntracked, profile });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? 'SOURCE_CAPTURE', message: 'Не удалось сохранить snapshot проекта.' } }));
  process.exitCode = 1;
}
