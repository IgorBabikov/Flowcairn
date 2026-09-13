import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { release } from 'node:os';
import { GraphError } from './io.mjs';

/** POSIX is a security boundary: private modes and process guards remain mandatory. */
export function assertRuntimePlatform({ platform = process.platform, node = process.versions.node } = {}) {
  if (Number(node.split('.')[0]) !== 22)
    throw new GraphError('NODE_VERSION', 'Нужен Node.js 22. Переключите версию в текущем терминале.');
  if (!['darwin', 'linux'].includes(platform))
    throw new GraphError('PLATFORM', 'Native Windows не поддерживается. Запустите Linux Node.js 22 в WSL2 и храните проект в Linux home, вне /mnt/c.');
}

export function isWsl(kernel = release()) {
  return /microsoft|wsl/i.test(kernel);
}

export function defaultProvider(platform = process.platform) {
  if (platform === 'darwin') return 'codex';
  if (platform === 'linux') return 'openai';
  throw new GraphError('PLATFORM', 'Native Windows не поддерживается; используйте Linux в WSL2.');
}

/** Refuse shared Windows filesystems even when DrvFs metadata imitates Unix modes. */
export function assertProjectPlatform(root, { platform = process.platform, kernel = release(), filesystem = statfsSync, mountInfo = () => readFileSync('/proc/self/mountinfo', 'utf8') } = {}) {
  if (platform !== 'linux' || !isWsl(kernel)) return;
  if (!/wsl2/i.test(kernel))
    throw new GraphError('WSL_VERSION', 'Требуется WSL2. WSL1 не входит в поддерживаемую границу.');
  const canonical = realpathSync(root);
  const unsupported = new Set([0x9fa0, 0x5346544e, 0x65735546, 0x4d44, 0x2011bab0]);
  const stat = filesystem(canonical);
  const mounts = mountInfo();
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  const mount = mounts.split('\n').map((line) => {
    const [left, right] = line.split(' - ');
    return { point: decode(left?.split(' ')[4] ?? ''), type: right?.split(' ')[0] };
  }).filter(({ point }) => point && (canonical === point || canonical.startsWith(point.endsWith('/') ? point : point + '/')))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (!mount || /^\/mnt\/[a-z](?:\/|$)/i.test(canonical) || unsupported.has(Number(stat.type)) || /^(?:9p|drvfs|fuse.*|ntfs.*|vfat|exfat|cifs)$/i.test(mount.type ?? ''))
    throw new GraphError('WSL_FILESYSTEM', 'Для Flowcairn нужен проект на Linux-файловой системе WSL2 (например ~/projects). Windows mounts и общие файловые системы не поддерживаются.');
}
