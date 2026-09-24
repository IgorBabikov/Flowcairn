import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

/** Resolve Git for the host; never use a .cmd/.bat shell shim. Git remains optional in direct mode. */
export function gitExecutable({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return '/usr/bin/git';
  const candidates = [
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((root) => path.win32.join(root, 'Git', 'cmd', 'git.exe')),
    ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
    ...(env.PATH ?? '').split(';').filter((item) => path.win32.isAbsolute(item)).map((root) => path.win32.join(root, 'git.exe')),
  ];
  for (const candidate of candidates) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate); } catch { /* next installed path */ }
  }
  return 'git.exe';
}

export function hostSystemEnvironment({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return {};
  const names = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'ProgramFiles', 'ProgramW6432', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'PUBLIC', 'ALLUSERSPROFILE'];
  const normalized = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  return Object.fromEntries(names.flatMap((name) => normalized.get(name.toUpperCase()) ? [[name, normalized.get(name.toUpperCase())]] : []));
}

// Git for Windows maps this spelling to NUL; Node's os.devNull is rejected.
// https://github.com/git-for-windows/git/blob/main/compat/mingw.c
export const gitNullDevice = '/dev/null';
