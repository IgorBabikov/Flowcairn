import path from 'node:path';
import { GraphError } from './io.mjs';

/** Flowcairn release hosts: macOS and native Windows only. */
export function assertRuntimePlatform({ platform = process.platform, node = process.versions.node } = {}) {
  if (Number(node.split('.')[0]) !== 22)
    throw new GraphError('NODE_VERSION', 'Нужен Node.js 22. Переключите версию в текущем терминале.');
  if (!['darwin', 'win32'].includes(platform))
    throw new GraphError('PLATFORM', 'Поддерживаются macOS и нативный Windows с Node.js 22.');
}

export function defaultProvider(platform = process.platform) {
  if (platform === 'darwin' || platform === 'win32') return 'codex';
  throw new GraphError('PLATFORM', 'Операционная система не поддерживается.');
}

/** Refuse Windows UNC and network paths; macOS uses its normal local filesystem rules. */
export function assertProjectPlatform(root, { platform = process.platform } = {}) {
  if (platform === 'darwin') return;
  if (platform !== 'win32') throw new GraphError('PLATFORM', 'Поддерживаются macOS и нативный Windows.');
  if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') || !path.win32.isAbsolute(root))
    throw new GraphError('WINDOWS_FILESYSTEM', 'Нужен проект на локальном диске Windows; UNC и сетевые пути не поддерживаются.');
}
