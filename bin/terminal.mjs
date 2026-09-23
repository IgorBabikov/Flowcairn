import { stripVTControlCharacters } from 'node:util';

/** Human-only terminal presentation. Machine output never passes through here. */
export function paint(output, code, text, env = process.env) {
  return output.isTTY && !env.CI && env.TERM !== 'dumb' && !Object.hasOwn(env, 'NO_COLOR')
    ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function authorLink(output, env = process.env) {
  if (!output.isTTY || env.CI || env.TERM === 'dumb') return '';
  const label = paint(output, '1;4;38;5;32', 'Telegram автора', env);
  return `\x1b]8;;https://t.me/Babikov_build\x1b\\${label}\x1b]8;;\x1b\\`;
}

export function printCard(title, lines, { output = process.stdout, author = false, env = process.env } = {}) {
  const columns = output.columns || 80;
  const decorated = output.isTTY && env.TERM !== 'dumb' && !env.CI && columns >= 24;
  const limit = Math.max(1, Math.min(68, columns - (decorated ? 6 : 2)));
  const border = (text) => paint(output, '38;5;99', text, env);
  const rows = lines.flatMap((line) => wrapLine(stripVTControlCharacters(line), limit));
  if (author) {
    const link = authorLink(output, env);
    if (link) rows.push('', link);
  }
  const width = Math.min(limit, Math.max(title.length + 2, ...rows.map(visibleWidth)));
  output.write('\n');
  if (decorated) {
    output.write(`${border('╭─ ')}${paint(output, '1;38;5;99', title, env)}${border(' ' + '─'.repeat(width - title.length - 1) + '╮')}\n`);
    output.write(`${border('│')}${' '.repeat(width + 2)}${border('│')}\n`);
  } else output.write(`${title}\n`);
  for (const row of rows) {
    const styled = row.startsWith('✓ ')
      ? `${paint(output, '32', '✓', env)} ${paint(output, '1', row.slice(2), env)}` : row;
    output.write(decorated
      ? `${border('│')} ${styled}${' '.repeat(width - visibleWidth(row))} ${border('│')}\n`
      : `  ${styled}\n`);
  }
  if (decorated) output.write(`${border('│')}${' '.repeat(width + 2)}${border('│')}\n${border('╰' + '─'.repeat(width + 2) + '╯')}\n`);
  output.write('\n');
}

function visibleWidth(text) {
  return Array.from(stripVTControlCharacters(text)).length;
}

/** Fixed Russian UI copy wraps at word boundaries; oversized tokens are split. */
function wrapLine(text, width) {
  const rows = [];
  let row = '';
  for (let word of text.split(/\s+/u).filter(Boolean)) {
    if (row && visibleWidth(row) + 1 + visibleWidth(word) > width) { rows.push(row); row = ''; }
    while (visibleWidth(word) > width) {
      const chars = Array.from(word);
      rows.push(chars.slice(0, width).join(''));
      word = chars.slice(width).join('');
    }
    if (word) row += (row ? ' ' : '') + word;
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

export function printReady(url, { output = process.stdout, author = false } = {}) {
  printCard('Flowcairn', [
    `${paint(output, '32', '✓')} ${paint(output, '1', 'Интерфейс запущен')}`,
    '',
    'Опишите задачу — сначала вы увидите план.',
    'Остановить: Ctrl+C',
  ], { output, author });
  // Keep the full session URL outside the frame: terminal soft-wrap preserves
  // copying and URL detection without inserting borders into the token.
  output.write(`Открыть в браузере:\n${paint(output, '4;36', url)}\n`);
  output.write(wrapLine('Не публикуйте этот адрес: он содержит токен сессии.', Math.max(1, (output.columns || 80) - 1)).join('\n') + '\n\n');
}
