import { isTrustedMode } from './host-filesystem.mjs';
import { parse } from 'smol-toml';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GraphError } from './io.mjs';

/** Read only model defaults. Never import hooks, commands, permissions, or auth. */
export function codexModelSettings(configPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml')) {
  let fd;
  try {
    fd = openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 || !isTrustedMode(before)) throw new Error('unsafe config');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('changed config');
    const config = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const model = config.model;
    const reasoningEffort = config.model_reasoning_effort;
    if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model) || /^(sk-|sess-)/i.test(model))) throw new Error('invalid model');
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort))) throw new Error('invalid effort');
    return { model: model ?? 'provider-default', reasoningEffort: reasoningEffort ?? null, source: 'codex-cli-user-config' };
  } catch (error) {
    if (error.code === 'ENOENT') return { model: 'provider-default', reasoningEffort: null, source: 'codex-cli-default' };
    throw new GraphError('CODEX_MODEL_SETTINGS_REQUIRED', 'Укажите модель и усиление в настройках flowcairn либо задайте model и model_reasoning_effort в конфигурации Codex CLI. Выбор активного чата VS Code автоматически не считывается.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
