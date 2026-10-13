import { lstatSync } from 'node:fs';
import { GraphError, hashObject } from './io.mjs';
import { readContextFile } from './project-context.mjs';
import { containedCheckPath } from './check-toolchain.mjs';
import { VerificationReportSpecSchema } from './check-schemas.mjs';
import { hasSecretContent } from './source-policy.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

/** Read exactly one registered report, using the existing no-link stable UTF-8 reader. */
export function captureVerificationReport(root, input) {
  const spec = VerificationReportSpecSchema.parse(input);
  const file = containedCheckPath(root, spec.path, { missing: true });
  let stat;
  try { stat = lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_REPORT_BYTES))
    fail('CHECK_REPORT_UNSAFE', 'Отчет должен быть ограниченным обычным файлом без ссылок.');
  const loaded = readContextFile(root, spec.path, { maxBytes: MAX_REPORT_BYTES });
  const after = lstatSync(file, { bigint: true });
  const identity = (value) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
  if (hashObject(identity(stat)) !== hashObject(identity(after)))
    fail('CHECK_REPORT_DRIFT', 'Отчет изменился во время чтения.');
  return { path: spec.path, hash: loaded.hash, identity: hashObject(identity(after)), text: loaded.text };
}

/** A pre-existing unchanged file cannot become evidence for another invocation. */
export function readFreshVerificationReport(root, input, previous = null) {
  const report = captureVerificationReport(root, input);
  if (!report) fail('CHECK_REPORT_MISSING', 'Зарегистрированная проверка не создала отчет.');
  if (previous && previous.identity === report.identity)
    fail('CHECK_REPORT_STALE', 'Отчет не обновлен текущим запуском проверки.');
  if (hasSecretContent(report.text)) fail('CHECK_REPORT_UNSAFE', 'Отчет содержит данные, исключенные политикой секретов.');
  let value;
  try { value = JSON.parse(report.text); }
  catch { fail('CHECK_REPORT_INVALID', 'Нужен полный JSON-отчет зарегистрированного verifier.'); }
  return { path: report.path, hash: report.hash, value };
}
