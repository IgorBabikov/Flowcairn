import { TextDecoder } from 'node:util';
import { GraphError, sha256 } from './io.mjs';

export const JSON_TRANSFER_LIMITS = Object.freeze({ transfers: 100, keysPerTransfer: 1000, totalKeys: 10000, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
const HASH = /^[a-f0-9]{64}$/;
const deny = (message) => { throw new GraphError('PATCH_DENIED', message); };

/** Validate JSON without losing numeric precision; retain exact top-level value lexemes. */
export function parseJsonObjectEntries(bytes) {
  if (Buffer.byteLength(bytes) > JSON_TRANSFER_LIMITS.fileBytes) deny('JSON file превышает 8 MiB');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(bytes)); }
  catch { deny('JSON source должен быть UTF-8'); }
  if (text.includes('\0')) deny('JSON source содержит NUL');
  let cursor = 0, tokens = 0;
  const entries = new Map();
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') {
        try { return JSON.parse(text.slice(start, cursor)); }
        catch { deny('Некорректная JSON string'); }
      }
    }
    deny('Незавершенная JSON string');
  };
  const value = (depth) => {
    if (depth > 64 || ++tokens > 500000) deny('JSON source превышает предел структуры');
    whitespace();
    const char = text[cursor];
    if (char === '"') { string(); return; }
    if (char === '{') {
      cursor++; whitespace();
      const keys = new Set();
      if (text[cursor] === '}') { cursor++; return; }
      while (cursor < text.length) {
        if (text[cursor] !== '"') deny('JSON object требует string key');
        const key = string();
        if (keys.has(key)) deny('JSON source содержит повторяющийся key');
        keys.add(key); whitespace();
        if (text[cursor++] !== ':') deny('Некорректный JSON object');
        whitespace(); const start = cursor;
        value(depth + 1);
        if (depth === 0) entries.set(key, text.slice(start, cursor));
        whitespace();
        if (text[cursor] === '}') { cursor++; return; }
        if (text[cursor++] !== ',') deny('Некорректный JSON object');
        whitespace();
      }
      deny('Незавершенный JSON object');
    }
    if (char === '[') {
      cursor++; whitespace();
      if (text[cursor] === ']') { cursor++; return; }
      while (cursor < text.length) {
        value(depth + 1); whitespace();
        if (text[cursor] === ']') { cursor++; return; }
        if (text[cursor++] !== ',') deny('Некорректный JSON array');
      }
      deny('Незавершенный JSON array');
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
    if (!literal) deny('Некорректное JSON value');
    cursor += literal[0].length;
  };
  whitespace();
  if (text[cursor] !== '{') deny('JSON transfers требуют plain object');
  value(0); whitespace();
  if (cursor !== text.length) deny('Лишнее содержимое после JSON object');
  return entries;
}

export function validateJsonTransfers(transfers, validatePath) {
  if (!Array.isArray(transfers) || transfers.length > JSON_TRANSFER_LIMITS.transfers) deny('JsonTransfers должны быть bounded массивом');
  let count = 0;
  const moved = new Set();
  const normalized = transfers.map((transfer) => {
    if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer) ||
        Object.keys(transfer).sort().join(',') !== 'from,keys,previousHash,targetPreviousHash,to') deny('JsonTransfer содержит недопустимые поля');
    const from = validatePath(transfer.from), to = validatePath(transfer.to);
    if (from === to) deny('JsonTransfer source и target совпадают');
    if (!HASH.test(transfer.previousHash) || (transfer.targetPreviousHash !== null && !HASH.test(transfer.targetPreviousHash))) deny('JsonTransfer hashes недопустимы');
    if (!Array.isArray(transfer.keys) || !transfer.keys.length || transfer.keys.length > JSON_TRANSFER_LIMITS.keysPerTransfer ||
        transfer.keys.some((key) => typeof key !== 'string' || !key.length || key.length > 1024 || key.includes('\0'))) deny('JsonTransfer keys недопустимы');
    count += transfer.keys.length;
    if (count > JSON_TRANSFER_LIMITS.totalKeys) deny('Слишком много переносимых JSON keys');
    for (const key of transfer.keys) {
      const identity = JSON.stringify([from, key]);
      if (moved.has(identity)) deny('Один JSON key переносится несколько раз');
      moved.add(identity);
    }
    return { from, to, previousHash: transfer.previousHash, targetPreviousHash: transfer.targetPreviousHash, keys: [...transfer.keys] };
  });
  const sources = new Set(normalized.map((item) => item.from));
  if (normalized.some((item) => sources.has(item.to))) deny('JSON source не может быть target в той же batch');
  return normalized;
}

/** readFile is the patch executor's hash/scope/physical-file checked reader. No filesystem access here. */
export function prepareJsonTransfers(transfers, readFile) {
  const documents = new Map();
  let beforeBytes = 0;
  const load = (file, previousHash) => {
    if (documents.has(file)) {
      const existing = documents.get(file);
      if (existing.previousHash !== previousHash) deny('JsonTransfers расходятся в BEFORE hash общего файла');
      return existing;
    }
    const content = readFile(file, previousHash);
    if (content !== null && (sha256(content) !== previousHash || Buffer.byteLength(content) > JSON_TRANSFER_LIMITS.fileBytes)) deny('JSON source hash или размер не совпадает');
    if (content === null && previousHash !== null) deny('JSON source отсутствует');
    beforeBytes += content === null ? 0 : Buffer.byteLength(content);
    if (beforeBytes > JSON_TRANSFER_LIMITS.totalBytes) deny('JSON inputs превышают 32 MiB');
    const document = { previousHash, entries: content === null ? new Map() : parseJsonObjectEntries(content) };
    documents.set(file, document); return document;
  };
  for (const transfer of transfers) {
    const source = load(transfer.from, transfer.previousHash), target = load(transfer.to, transfer.targetPreviousHash);
    for (const key of transfer.keys) {
      if (!source.entries.has(key)) deny('Переносимый JSON key отсутствует в source');
      if (target.entries.has(key)) deny('JSON target уже содержит переносимый key');
      target.entries.set(key, source.entries.get(key)); source.entries.delete(key);
    }
  }
  let afterBytes = 0;
  const sources = new Set(transfers.map((item) => item.from));
  // Publish destinations first: an interrupted batch must not lose values removed from its sources.
  return [...documents].sort(([left], [right]) => Number(sources.has(left)) - Number(sources.has(right))).map(([file, document]) => {
    const content = document.entries.size ? `{\n${[...document.entries].map(([key, raw]) => `  ${JSON.stringify(key)}: ${raw}`).join(',\n')}\n}\n` : '{}\n';
    const bytes = Buffer.byteLength(content); afterBytes += bytes;
    if (bytes > JSON_TRANSFER_LIMITS.fileBytes || afterBytes + beforeBytes > JSON_TRANSFER_LIMITS.totalBytes) deny('JSON outputs превышают ограничение размера');
    return { path: file, previousHash: document.previousHash, content };
  });
}
