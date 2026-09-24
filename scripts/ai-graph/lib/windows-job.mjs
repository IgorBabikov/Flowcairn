import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError } from './io.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (stage = 'validation', details = {}) => {
  throw new GraphError('WINDOWS_JOB_UNAVAILABLE', `Windows Job launcher недоступен: ${stage}. Запуск без контроля дерева процессов запрещен.`, { stage, ...details });
};
function regular(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) fail('generated-file-validation');
  return stat;
}

// Windows servicing can hardlink OS binaries. This exception applies only to
// fixed .NET compiler paths, never generated helpers, source copies or receipts.
function compiler({ system = process.env.SystemRoot, statFile = lstatSync, canonical = realpathSync } = {}) {
  if (!system || !/^[a-z]:\\[^\r\n]*$/i.test(system)) fail('system-root');
  const candidates = [];
  for (const framework of ['Framework64', 'Framework']) {
    const executable = path.win32.join(system, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    try {
      const stat = statFile(executable);
      const normalized = canonical(executable).toLowerCase() === path.win32.resolve(executable).toLowerCase();
      const info = { framework, exists: true, regular: stat.isFile(), symlink: stat.isSymbolicLink(), links: stat.nlink, canonical: normalized };
      if (info.regular && !info.symlink && info.canonical && info.links >= 1) return executable;
      candidates.push(info);
    } catch { candidates.push({ framework, exists: false }); }
  }
  fail('compiler-discovery', { candidates });
}

export const WINDOWS_JOB_TESTING = Object.freeze({ compiler });

/** No cached binary is trusted across processes: compile the packaged source in a fresh private directory. */
export function prepareWindowsJob(command, { platform = process.platform, run = spawnSync, findCompiler = compiler, parent = tmpdir() } = {}) {
  if (platform !== 'win32') fail('platform');
  let directory;
  let stage = 'source-read';
  try {
    const sourceFile = fileURLToPath(new URL('./windows-job.cs', import.meta.url));
    regular(sourceFile);
    const source = readFileSync(sourceFile);
    const sourceHash = hash(source);
    stage = 'compiler-discovery';
    const compilerPath = findCompiler();
    stage = 'temporary-directory';
    directory = mkdtempSync(path.join(realpathSync(parent), `flowcairn-job-${sourceHash.slice(0, 12)}-`));
    const copy = path.join(directory, 'launcher.cs');
    const executable = path.join(directory, 'launcher.exe');
    const receipt = path.join(directory, `${randomUUID()}.json`);
    writeFileSync(copy, source, { flag: 'wx', mode: 0o600 });
    stage = 'compile';
    const result = run(compilerPath, ['/nologo', '/noconfig', '/target:exe', '/optimize+', `/out:${executable}`, copy], {
      shell: false, windowsHide: true, timeout: 30000, maxBuffer: 65536, encoding: 'utf8',
    });
    if (result.error || result.signal || result.status !== 0) fail('compile', {
      status: Number.isInteger(result.status) ? result.status : null,
      failure: result.error ? 'spawn-error' : result.signal ? 'signal' : 'exit-code',
    });
    stage = 'executable-validation';
    const stat = regular(executable);
    if (stat.size < 2 || stat.size > 1024 * 1024) fail();
    const bytes = readFileSync(executable);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail();
    const executableHash = hash(bytes);
    return {
      command: { ...command, executable, args: [receipt, command.executable, ...command.args] },
      sourceHash, executableHash,
      verify() { regular(executable); if (hash(readFileSync(executable)) !== executableHash) fail(); },
      readCompletion() {
        try {
          if (regular(receipt).size > 1024) return null;
          const result = JSON.parse(readFileSync(receipt, 'utf8'));
          return result.version === 1 && result.reaped === true && Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 0xffffffff ? result : null;
        } catch { return null; }
      },
      dispose() { rmSync(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (directory) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Preserve the bounded original failure. */ } }
    if (error instanceof GraphError && error.code === 'WINDOWS_JOB_UNAVAILABLE') throw error;
    fail(stage);
  }
}
