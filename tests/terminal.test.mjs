import test from 'node:test';
import assert from 'node:assert/strict';
import { authorLink, paint, printCard } from '../bin/terminal.mjs';
import { printInitialization } from '../bin/flowcairn.mjs';
import { stripVTControlCharacters } from 'node:util';

test('closed frame keeps every edge aligned at wide and narrow terminal widths', () => {
  for (const columns of [32, 40, 48, 80, 120]) {
    let text = '';
    printCard('Flowcairn', ['✓ Интерфейс запущен', '', 'Опишите задачу обычным языком — сначала вы увидите план.', 'Ctrl+C — остановить сервер.'], {
      output: { isTTY: true, columns, write: value => { text += value; } }, author: true, env: {},
    });
    const rows = stripVTControlCharacters(text).trim().split('\n');
    assert.ok(rows[0].startsWith('╭') && rows[0].endsWith('╮'));
    assert.ok(rows.at(-1).startsWith('╰') && rows.at(-1).endsWith('╯'));
    assert.ok(rows.every(row => Array.from(row).length === Array.from(rows[0]).length));
    assert.ok(rows.every(row => row.length < columns));
    assert.match(text, /Telegram автора/);
    assert.doesNotMatch(stripVTControlCharacters(text), /обычны\s*│/);
  }
});

test('author hyperlink has exact destination and only the requested visible label', () => {
  const link = authorLink({ isTTY: true }, {});
  assert.ok(link.includes('\x1b]8;;https://t.me/Babikov_build\x1b\\'));
  assert.equal(link.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, ''), 'Telegram автора');
  assert.ok(link.endsWith('\x1b]8;;\x1b\\'));
});

test('redirected output, CI and dumb terminals do not contain promotion or escape codes', () => {
  for (const [isTTY, env] of [[false, {}], [true, { CI: 'true', NO_COLOR: '' }], [true, { TERM: 'dumb' }]]) {
    let text = '';
    printCard('Flowcairn', ['Проект настроен'], { output: { isTTY, write: value => { text += value; } }, author: true, env });
    assert.doesNotMatch(text, /Telegram|t\.me|\x1b/);
    assert.match(text, /Проект настроен/);
  }
});

test('NO_COLOR disables styling without destroying the hyperlink label', () => {
  assert.equal(paint({ isTTY: true }, '1;94', 'Текст', { NO_COLOR: '' }), 'Текст');
  assert.doesNotMatch(authorLink({ isTTY: true }, { NO_COLOR: '' }), /\x1b\[/);
});

test('repeated setup, dry-run and pending server startup never show the author link', () => {
  for (const [result, launching] of [[{ created: false }, false], [{ created: true, dryRun: true, changes: [] }, false], [{ created: true }, true]]) {
    let text = '';
    printInitialization(result, { launching, output: { isTTY: true, write: value => { text += value; } } });
    assert.doesNotMatch(text, /Telegram|t\.me/);
    assert.doesNotMatch(text, /Теперь откроется Graph/);
  }
});
