import { parse } from 'smol-toml';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GraphError } from './io.mjs';

/** Read only model defaults. Never import hooks, commands, permissions, or auth. */
export function codexModelSettings(configPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml')) {
  let fd;
  try {
    fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 || (before.mode & 0o022)) throw new Error('unsafe config');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('changed config');
    const config = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const model = config.model;
    const reasoningEffort = config.model_reasoning_effort;
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model) || /^(sk-|sess-)/i.test(model) ||
        typeof reasoningEffort !== 'string' || !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('missing defaults');
    return { model, reasoningEffort, source: 'codex-cli-user-config' };
  } catch {
    throw new GraphError('CODEX_MODEL_SETTINGS_REQUIRED', 'Укажите модель и усиление в настройках Flowcairn либо задайте model и model_reasoning_effort в конфигурации Codex CLI. Выбор активного чата VS Code автоматически не считывается.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
