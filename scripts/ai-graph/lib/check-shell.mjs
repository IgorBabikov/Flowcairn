import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { checkFileIdentity, resolveCheckExecutable } from './check-toolchain.mjs';

const unsupported = () => { throw new GraphError('CHECK_SHELL_CONFIG_UNSUPPORTED',
  'Не удалось надежно определить script-shell. Укажите статический абсолютный путь к shell; подстановки, поиск shell через PATH и относительный shell вместе с workspaces требуют другой конфигурации.'); };

/** Use npm's own installed INI parser. No package installation or command probe is performed. */
export function packageCheckShell(worktree, manager, command) {
  if (!['npm', 'pnpm'].includes(manager)) return null;
  const file = path.join(worktree, '.npmrc');
  let before;
  try { before = checkFileIdentity(file, { opaque: true, maxBytes: 256 * 1024 }); }
  catch (error) { if (error.code === 'ENOENT') return null; unsupported(); }
  let fd;
  try {
    fd = openSync(file, noFollowReadFlags());
    const bytes = readFileSync(fd);
    if (sha256(bytes) !== before.hash || hashObject(checkFileIdentity(file, { opaque: true, maxBytes: 256 * 1024 })) !== hashObject(before))
      throw new GraphError('CHECK_REGISTRY_DRIFT', 'Конфигурация проверки изменилась во время чтения.');
    const npmEntry = manager === 'npm' ? command.args[0] : realpathSync(path.join(path.dirname(process.execPath),
      process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'));
    const config = createRequire(npmEntry)('ini').parse(bytes.toString('utf8'));
    // npm also expands environment variables in keys. Do not silently overlook a dynamic selector.
    if (Object.keys(config).some((key) => key.includes('${'))) unsupported();
    const shell = config['script-shell'];
    if (shell === undefined || shell === null || shell === '') return null;
    if (typeof shell !== 'string' || shell.includes('${') || /[\0\r\n]/.test(shell) || /^(?:\\\\|\/\/)/.test(shell)) unsupported();
    const absolute = path.isAbsolute(shell);
    if (!absolute && (!shell.startsWith('./') || (config.workspaces !== undefined && config.workspaces !== false) || config.workspace !== undefined)) unsupported();
    return { selector: shell, ...resolveCheckExecutable(worktree, shell, command.env) };
  } catch (error) {
    if (error instanceof GraphError && ['CHECK_REGISTRY_DRIFT', 'CHECK_SHELL_CONFIG_UNSUPPORTED'].includes(error.code)) throw error;
    unsupported();
  } finally { if (fd !== undefined) closeSync(fd); }
}
