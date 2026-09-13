import { GraphError } from '../scripts/ai-graph/lib/io.mjs';

const REGISTRY = 'https://registry.npmjs.org/flowcairn/latest';
const REPOSITORY = 'https://github.com/IgorBabikov/flowcairn';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Explicit metadata-only check. Never execute registry content or mutate an installation. */
export async function checkUpdate(currentVersion, { fetcher = fetch } = {}) {
  const response = await fetcher(REGISTRY, {
    redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404)
    return { currentVersion, published: false, updateAvailable: false, source: REGISTRY, message: 'Пакет пока не опубликован в npm. Установка не изменена.' };
  if (!response.ok) throw new GraphError('UPDATE_UNAVAILABLE', 'Не удалось проверить версию в официальном npm registry. Установка не изменена.');
  const reader = response.body?.getReader();
  if (!reader) throw new GraphError('UPDATE_METADATA', 'Registry не вернул метаданные.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new GraphError('UPDATE_METADATA', 'Метаданные registry превышают лимит.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  let metadata;
  try { metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GraphError('UPDATE_METADATA', 'Некорректные метаданные registry.'); }
  if (!metadata || metadata.name !== 'flowcairn' || typeof metadata.version !== 'string' || metadata.version.length > 40 || !stable.test(metadata.version) ||
      typeof metadata.repository?.url !== 'string' || metadata.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') !== REPOSITORY)
    throw new GraphError('UPDATE_SOURCE', 'Метаданные не соответствуют доверенному репозиторию Flowcairn.');
  const current = currentVersion.split('-')[0].split('.').map(Number);
  const latest = metadata.version.split('.').map(Number);
  const order = latest.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0;
  return {
    currentVersion, latestVersion: metadata.version, published: true,
    updateAvailable: order > 0 || (order === 0 && currentVersion.includes('-')),
    source: REGISTRY, repository: REPOSITORY,
    message: 'Проверены только метаданные npm и адрес репозитория. Это не проверка содержимого релиза. Установка и активные планы не изменены; установку выбранной версии выполните отдельно после проверки релиза.',
  };
}
