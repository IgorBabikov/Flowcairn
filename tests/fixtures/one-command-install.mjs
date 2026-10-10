import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const redact = text => String(text).replace(/(#session=)[A-Za-z0-9_-]+/g, '$1[REDACTED]');
export function record(directory, name, value) {
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'));
}
export function fixtureProvider(directory) {
  mkdirSync(directory, { recursive: true });
  const probeLog = path.join(directory, 'probes.jsonl');
  if (process.platform === 'win32') {
    const source = path.join(directory, 'Provider.cs'), executable = path.join(directory, 'agent.exe');
    writeFileSync(source, `using System; using System.IO; class Provider {
      static int Main(string[] args) {
        File.AppendAllText(${JSON.stringify(probeLog)}, String.Join(" ", args)+Environment.NewLine);
        if(args.Length==1 && args[0]=="--version") Console.WriteLine("fixture-cli 1.0");
        else if(Array.IndexOf(args,"--help")>=0) Console.WriteLine("--print --output-format --sandbox --mode");
        else if(args.Length==3 && args[0]=="status" && args[1]=="--format" && args[2]=="json") Console.WriteLine(${JSON.stringify('{"isAuthenticated":true}')});
        else { Console.Error.WriteLine("Fixture forbids inference/login"); return 90; }
        return 0;
      }
    }`);
    const compiler = ['Framework64', 'Framework'].map(name => path.join(process.env.SystemRoot ?? '', 'Microsoft.NET', name, 'v4.0.30319/csc.exe')).find(existsSync);
    assert.ok(compiler, 'Native Windows fixture needs the documented .NET Framework compiler');
    const result = spawnSync(compiler, ['/nologo', `/out:${executable}`, source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return { executable, probeLog };
  }
  const executable = path.join(directory, 'agent');
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(probeLog)},JSON.stringify(args)+'\\n');
    if(args.length===1&&args[0]==='--version') console.log('fixture-cli 1.0');
    else if(args.includes('--help')) console.log('--print --output-format --sandbox --mode');
    else if(args[0]==='status'){assert.deepEqual(args,['status','--format','json']);console.log(JSON.stringify({isAuthenticated:true}));}
    else{console.error('Fixture forbids inference/login');process.exit(90);}`, { mode: 0o700 });
  return { executable, probeLog };
}
export function tracePreload(file) {
  writeFileSync(file, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
    const trace=process.env.FLOWCAIRN_INSTALL_TRACE;
    const record=value=>{if(trace)fs.appendFileSync(trace,JSON.stringify(value)+'\\n');};
    let entry;try{entry=fs.realpathSync(process.argv[1]);}catch{}
    if(entry&&entry.endsWith(path.join('bin','flowcairn.mjs')))record({event:'cli',pid:process.pid,runtimeRoot:path.dirname(path.dirname(entry)),projectRoot:process.cwd()});
    const original=cp.spawn;cp.spawn=function(file,args,options){if(['open','rundll32.exe'].includes(path.basename(file)))record({event:'browser',executable:file});return original.call(this,file,args,options);};
    require('node:module').syncBuiltinESMExports();`);
}
export const readTrace = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
export async function artifactRegistry(tarball, manifest) {
  const counts = { metadata: 0, tarball: 0, dependencies: 0 };
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  let origin;
  const artifactPath = `/${manifest.name}/-/artifact.tgz`;
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if ([`/${manifest.name}`, `/${manifest.name}/${manifest.version}`].includes(pathname)) {
      counts.metadata++;
      const version = { ...manifest, dist: { tarball: origin + artifactPath, integrity } };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
    } else if (pathname === artifactPath) {
      counts.tarball++; response.setHeader('Content-Type', 'application/octet-stream');
      createReadStream(tarball).pipe(response);
    } else {
      counts.dependencies++;
      response.writeHead(302, { Location: 'https://registry.npmjs.org' + pathname }); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin + '/', counts, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function run(executable, args, { cwd, env, timeout = 30_000 } = {}) {
  return spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout });
}
export async function start(executable, args, { cwd, env, trace, interactive = false, timeout = 180_000, evidence, name }) {
  let command = executable, commandArgs = args;
  if (interactive) {
    assert.equal(process.platform, 'darwin', 'This PTY gate verifies macOS; native Windows terminal acceptance is separate');
    command = process.env.FLOWCAIRN_PYTHON ?? '/usr/bin/python3';
    commandArgs = [fileURLToPath(new URL('./one-command-pty.py', import.meta.url)), executable, ...args];
  }
  const child = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stdout = '', stderr = '', token, timer, completed = false, choiceCount = 0, readAnswered = false, graphAnswered = false;
  const stop = async () => {
    for (const entry of readTrace(trace).filter(item => item.event === 'cli')) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    else child.kill('SIGTERM');
    await closed;
    record(evidence, `${name}.stdout.log`, stdout); record(evidence, `${name}.stderr.log`, stderr);
  };
  try {
    await new Promise((resolve, reject) => {
      const receive = (chunk, channel) => {
        const text = chunk.toString();
        if (channel === 'stdout') stdout += text; else stderr += text;
        const transcript = (stdout + stderr).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
        if (interactive) {
          const choices = transcript.match(/Выбор \[1\]:/g)?.length ?? 0;
          while (choiceCount < choices && choiceCount < 2) { child.stdin.write(choiceCount++ === 0 ? '3\n' : '1\n'); }
          if (!readAnswered && transcript.includes('Действуют права клиента; Flowcairn не гарантирует недоступность всех секретов. [да / нет; Enter — нет]:')) { readAnswered = true; child.stdin.write('да\n'); }
          if (!graphAnswered && transcript.includes('Подключить Graph к правилам проекта? [да / нет; Enter — нет]:')) { graphAnswered = true; child.stdin.write('нет\n'); }
        }
        const session = transcript.match(/http:\/\/127\.0\.0\.1:\d+\/#session=([A-Za-z0-9_-]+)/);
        if (session) { token = session[1]; completed = true; clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', chunk => receive(chunk, 'stdout'));
      child.stderr.on('data', chunk => receive(chunk, 'stderr'));
      child.once('error', reject);
      child.once('close', (code, signal) => { if (!completed) { clearTimeout(timer); reject(Error(redact(`CLI exited ${code}/${signal}: ${stdout}\n${stderr}`))); } });
      timer = setTimeout(() => reject(Error(redact(`CLI startup timed out: ${stdout}\n${stderr}`))), timeout);
    });
    return { child, token, stop, transcript: () => stdout + stderr };
  } catch (error) { await stop(); throw error; }
  finally { clearTimeout(timer); }
}
export function installedRuntime(cache) {
  const npx = path.join(cache, '_npx');
  return readdirSync(npx).map(name => path.join(npx, name, 'node_modules/flowcairn')).find(root => existsSync(path.join(root, 'bin/flowcairn.mjs')));
}
