import picomatch from 'picomatch';
import { GraphError } from './io.mjs';

export const normalizeSourcePath = (value) => String(value).normalize('NFKC').replaceAll('\\', '/').toLowerCase();
const privateDirectories = new Set(['.git', '.ai', '.ai-orchestrator', '.agents', '.flowcairn.json', '.aws', '.azure', '.gcloud', '.ssh', '.kube', 'gcloud', '.codex', '.claude', '.cursor']);
const dependencyDirectories = new Set(['node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.pnpm-store']);
const outputDirectories = new Set(['dist', 'build', 'coverage', '.next', '.nuxt', '.cache', 'target']);
const binaryExtension = /\.(?:png|jpe?g|gif|webp|ico|avif|pdf|zip|gz|tar|7z|woff2?|ttf|otf|mp[34]|mov|wav|exe|dll|so|dylib|sqlite3?|db|wasm|class|pyc)$/;

export function isSensitivePath(value) {
  if (hasSecretContent(value)) return true;
  const parts = normalizeSourcePath(value).split('/');
  return parts.some((part) => {
    if (privateDirectories.has(part)) return true;
    if (/^(?:\.env|env)(?:\.|$)/.test(part) && !/\.(?:example|sample|template)$/.test(part)) return true;
    return /^(?:\.?(?:npmrc|pypirc|netrc)(?:\..*)?|\.?mcp\.json|claude_desktop_config\.json|settings\.local\.json|kubeconfig(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts)$/.test(part)
      || /\.(?:pem|key|p12|pfx)$/.test(part)
      || /(?:^|[._-])(?:secrets?|tokens?|credentials?|service[._-]?accounts?)(?:[._-]|$)/.test(part);
  });
}

export function hasSecretContent(value) {
  const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '/': '/', '\\': '\\' };
  const text = String(value).normalize('NFKC')
    .replace(/\\+(?:u([a-f0-9]{4})|(["'\\/bfnrt]))/gi, (_, hex, escaped) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) : escapes[escaped] ?? escaped)
    .normalize('NFKC');
  return /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(text)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/.test(text)
    || /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text)
    || /["']?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|token|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?[^\s"'`,;}{]{8,}/i.test(text)
    || /(?:secret|password|api[_-]?key)[^\r\n]{0,40}[A-Za-z0-9+/=_-]{32,}/i.test(text);
}

export function assertSafeText(text) {
  if (hasSecretContent(text)) throw new GraphError('UNSAFE_SOURCE', 'Текст исключен политикой безопасности.');
  return text;
}

/** A null reason means the complete UTF-8 file is eligible. */
export function classifySource(value, bytes, { denyGlobs = [] } = {}) {
  const normalized = normalizeSourcePath(value);
  const parts = normalized.split('/');
  if (isSensitivePath(normalized)) return { reason: 'sensitive-path' };
  if (denyGlobs.some((glob) => picomatch(normalizeSourcePath(glob), { dot: true, nonegate: true })(normalized))) return { reason: 'project-deny' };
  if (parts.some((part) => dependencyDirectories.has(part))) return { reason: 'dependency' };
  if (parts.some((part) => outputDirectories.has(part))) return { reason: 'output' };
  if (binaryExtension.test(normalized)) return { reason: 'binary' };
  if (bytes !== undefined && bytes !== null) {
    const buffer = Buffer.from(bytes);
    if (buffer.includes(0)) return { reason: 'binary' };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return { reason: 'binary' }; }
    if (hasSecretContent(text)) return { reason: 'secret-content' };
  }
  return { reason: null };
}
