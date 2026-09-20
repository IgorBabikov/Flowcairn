import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDirectTaskScope } from './lib/direct-scope.mjs';

test('natural task selects related source and configuration without unrelated project areas', () => {
  const files = [
    'src/localization/locale.json', 'src/localization/tmg.ts', 'src/localization/index.ts',
    'src/modules/bntl/index.ts', 'src/interfaces/operation.ts', 'src/unrelated/index.ts',
    'src/unrelated/secretly-long.ts', 'dictionaries/tmg.ru.json',
    'webpack.config.client.js', 'webpack.config.admin.js', 'webpack-plugins/base.js',
    'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'test-setup.ts',
  ];
  const candidates = ['src', 'dictionaries', 'webpack.config.client.js', 'webpack.config.admin.js',
    'webpack-plugins', 'package.json', 'package-lock.json', 'README.md', 'test-setup.ts'];
  const description = 'Удалить locale.json, перенести localization/tmg.ts, обновить localization/index.ts и tmg.ru.json. ' +
    'Для каждого modules нужен словарь. Удалить прт run locale отовсюду, настроить вебпак, сохранить типы. ' +
    'Обновить устаревшие правила в AGENTS.md.';
  const scope = selectDirectTaskScope(description, files, candidates);
  assert.deepEqual(scope, [
    'AGENTS.md', 'dictionaries', 'package.json', 'src/interfaces', 'src/localization', 'src/modules',
    'webpack-plugins', 'webpack.config.admin.js', 'webpack.config.client.js',
  ]);
  assert.ok(!scope.includes('src/unrelated'));
  assert.ok(!scope.includes('package-lock.json'));
  assert.ok(!scope.includes('README.md'));
});

test('README enters a direct task only when it is named', () => {
  assert.deepEqual(selectDirectTaskScope('Обновить README.md', ['README.md', 'src/index.ts'],
    ['README.md', 'src']), ['README.md']);
});

test('ambiguous large project stays bounded instead of granting every directory', () => {
  const names = Array.from({ length: 12 }, (_, index) => `area-${index}`);
  assert.throws(() => selectDirectTaskScope('Сделайте эту задачу', names.map((name) => `${name}/file.txt`), names),
    { code: 'INTAKE_SCOPE_UNCLEAR' });
});
