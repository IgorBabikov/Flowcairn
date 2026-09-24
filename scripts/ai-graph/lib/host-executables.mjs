import path from 'node:path';
import os from 'node:os';
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

export function hostSystemEnvironment() {
  if (process.platform !== 'win32') return {};
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH'].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

export const hostNullDevice = os.devNull;
