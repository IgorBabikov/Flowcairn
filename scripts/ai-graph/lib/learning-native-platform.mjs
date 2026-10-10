import path from 'node:path';
import { GraphError } from './io.mjs';

/** Platform command construction is not evidence of native sandbox enforcement. */
export function learningCodexNativeLayout(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new GraphError('LEARNING_CODEX_PLATFORM_UNVERIFIED', 'Для этой ОС или архитектуры нет учебного native profile.');
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  return { packageName: `@openai/codex-${platform}-${arch}`,
    triple: `${cpu}-${platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc'}`,
    binary: platform === 'win32' ? 'codex.exe' : 'codex' };
}

export function learningNativeEnvironment(provider, source = process.env, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform))
    throw new GraphError('LEARNING_PLATFORM_UNSUPPORTED', 'Учебный native adapter поддерживает только macOS и native Windows.');
  const env = { PATH: platform === 'win32' ? path.win32.join(source.SystemRoot ?? source.SYSTEMROOT ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' };
  const keys = ['HOME', ...(provider === 'codex' ? ['CODEX_HOME'] : ['CLAUDE_CONFIG_DIR'])];
  if (platform === 'win32') keys.push('SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP');
  for (const name of keys) {
    const key = platform === 'win32' ? Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase()) : name;
    if (key && source[key]) env[name.toUpperCase()] = source[key];
  }
  // Supervisor accepts uppercase environment names; Windows lookup ignores case.
  if (provider !== 'codex') env.DISABLE_AUTOUPDATER = '1';
  return env;
}
