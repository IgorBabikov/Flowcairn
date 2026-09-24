import path from 'node:path';
import { GraphError } from './io.mjs';

export function providerEnvironment(env = process.env, platform = process.platform) {
  const result = { PATH: platform === 'win32' ? (env.PATH ?? env.Path ?? '') : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', NO_COLOR: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  const names = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];
  if (platform === 'win32') names.push('SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA');
  for (const name of names) {
    const key = platform === 'win32' ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) : name;
    if (key && env[key]) result[name] = env[key];
  }
  return result;
}

export function assertProviderExecutablePlatform(executable, platform = process.platform) {
  if (platform === 'win32' && !/\.exe$/i.test(executable)) {
    throw new GraphError('PROVIDER_NATIVE_EXECUTABLE_REQUIRED', 'На Windows нужен native .exe CLI. Batch shims не запускаются через shell.');
  }
}

export function providerCandidates(provider, env = process.env, platform = process.platform) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path;
  const directories = String(env.PATH ?? env.Path ?? '').split(windows ? ';' : path.delimiter).filter(Boolean);
  const names = provider === 'claude' ? (windows ? ['claude.exe'] : ['claude']) : (windows ? ['cursor-agent.exe', 'agent.exe'] : ['cursor-agent', 'agent']);
  return directories.flatMap((directory) => [
    ...names.map((name) => paths.join(directory, name)),
    ...(windows && provider === 'claude' ? [paths.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')] : []),
  ]);
}

export function exactClaudeReadRule(file, platform = process.platform) {
  let normalized = file;
  if (platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(file)) throw new GraphError('PROVIDER_REVIEW_INVALID', 'Review требует локальный абсолютный путь.');
    normalized = `/${file[0].toLowerCase()}${file.slice(2).replaceAll('\\', '/')}`;
  }
  if (!normalized.startsWith('/') || /[\0\r\n()*?[\]{},]/u.test(normalized)) throw new GraphError('PROVIDER_REVIEW_INVALID', 'Review path не допускает шаблонов.');
  return `Read(/${normalized})`;
}
