import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSecretContent } from '../scripts/ai-graph/lib/source-policy.mjs';
import { createSecretContentScanner } from '../scripts/ai-graph/lib/stream-secret-policy.mjs';

function scan(text, width) {
  const scanner = createSecretContentScanner();
  for (let offset = 0; offset < text.length; offset += width) scanner.update(text.slice(offset, offset + width));
  return scanner.finish();
}

test('потоковая политика сохраняет запрет обычных, escaped и разделенных секретов', () => {
  const values = [
    '-----BEGIN PRIVATE KEY-----', 'Bearer ' + 'a'.repeat(30), 'ghp_' + 'a'.repeat(36),
    'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(10) + '.' + 'c'.repeat(10),
    'https://user:pass@host.invalid', 'api_key="synthetic-private-value"',
    'refreshToken = synthetic-private-value', 'password' + ' '.repeat(18000) + '= synthetic-private-value',
    'Bearer' + '\n '.repeat(18000) + 'a'.repeat(30),
    'https://' + 'u'.repeat(18000) + ':p@host.invalid',
    'eyJ' + 'a'.repeat(18000) + '.' + 'b'.repeat(10) + '.' + 'c'.repeat(10),
    'api_' + '\\'.repeat(18000) + 'u006bey=synthetic-private-value',
    '\\u0061pi_key=synthetic-private-value', 'ａｐｉ＿ｋｅｙ=synthetic-private-value',
  ];
  for (const text of values) {
    assert.equal(hasSecretContent(text), true, text.slice(0, 50));
    for (const width of [1, 7, 100, 65536]) assert.equal(scan(text, width), true, `${text.slice(0, 30)} / ${width}`);
  }
});

test('длинные обычные строки и переводимые action names остаются доступными', () => {
  for (const text of ['x'.repeat(2 * 1024 * 1024), 'a-'.repeat(20000) + 'value=ordinary',
    JSON.stringify({ 'security.User.generateToken': 'Сгенерировать', 'security.User.copyToken': 'Скопировать' }),
    '# guide\nFollow the rules.\n'.repeat(20000)]) {
    assert.equal(hasSecretContent(text), false);
    assert.equal(scan(text, 65536), false);
  }
});
