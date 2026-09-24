import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError } from './io.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new GraphError('WINDOWS_JOB_UNAVAILABLE', 'Windows Job launcher недоступен. Нужен встроенный .NET Framework C# compiler; запуск без контроля дерева процессов запрещен.'); };
function regular(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) fail();
  return stat;
}
function compiler() {
  const system = process.env.SystemRoot;
  if (!system || !/^[a-z]:\\[^\r\n]*$/i.test(system)) fail();
  for (const framework of ['Framework64', 'Framework']) {
    const executable = path.win32.join(system, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    try { regular(executable); return executable; } catch { /* Try only fixed system installations. */ }
  }
  fail();
}

/** No cached binary is trusted across processes: compile the packaged source in a fresh private directory. */
export function prepareWindowsJob(command, { platform = process.platform, run = spawnSync, findCompiler = compiler, parent = tmpdir() } = {}) {
  if (platform !== 'win32') fail();
  let directory;
  try {
    const sourceFile = fileURLToPath(new URL('./windows-job.cs', import.meta.url));
    regular(sourceFile);
    const source = readFileSync(sourceFile);
    const sourceHash = hash(source);
    const compilerPath = findCompiler();
    directory = mkdtempSync(path.join(realpathSync(parent), `flowcairn-job-${sourceHash.slice(0, 12)}-`));
    const copy = path.join(directory, 'launcher.cs');
    const executable = path.join(directory, 'launcher.exe');
    const receipt = path.join(directory, `${randomUUID()}.json`);
    writeFileSync(copy, source, { flag: 'wx', mode: 0o600 });
    const result = run(compilerPath, ['/nologo', '/noconfig', '/target:exe', '/optimize+', `/out:${executable}`, copy], {
      shell: false, windowsHide: true, timeout: 30000, maxBuffer: 65536, encoding: 'utf8',
    });
    if (result.error || result.signal || result.status !== 0) fail();
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
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    fail();
  }
}
