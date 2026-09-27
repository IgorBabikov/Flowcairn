import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSecretContent } from './lib/source-policy.mjs';

test('translation action names ending in Token are not credential assignments', () => {
  assert.equal(hasSecretContent(JSON.stringify({
    'security.User.generateToken': 'Сгенерировать',
    'security.User.copyToken': 'Скопировать',
  })), false);
});

test('explicit credential fields and token signatures remain excluded', () => {
  for (const key of ['token', 'authToken', 'access_token', 'apiKey', 'password', 'service.token', 'refresh_token', 'refreshToken', 'session_token', 'API_TOKEN', 'MY_API_TOKEN', 'sessionToken'])
    assert.equal(hasSecretContent(JSON.stringify({ [key]: 'synthetic-private-value' })), true, key);
  assert.equal(hasSecretContent(JSON.stringify({ generateToken: 'ghp_' + 'A'.repeat(36) })), true);
});

test('credential detection stays bounded on long generated identifiers', () => {
  const input = 'a-'.repeat(20000) + 'value=ordinary';
  const start = performance.now();
  assert.equal(hasSecretContent(input), false);
  assert.ok(performance.now() - start < 5000, 'generated code must not cause quadratic credential scanning');
});
