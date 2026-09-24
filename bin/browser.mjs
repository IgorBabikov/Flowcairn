import path from 'node:path';
import { spawn } from 'node:child_process';

/** Fixed executable and loopback URL only; browser failure never stops the local UI. */
export function openBrowser(url, { platform = process.platform, launcher = spawn } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#session=[A-Za-z0-9_-]+$/.test(url))
    return Promise.resolve(false);
  const executable = platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? '/usr/bin/xdg-open' : platform === 'win32' && process.env.SystemRoot ? path.win32.join(process.env.SystemRoot, 'System32', 'rundll32.exe') : null;
  if (!executable) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child, timer;
    const finish = (success) => { clearTimeout(timer); resolve(success); };
    try {
      child = launcher(executable, platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { shell: false, stdio: 'ignore' });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      timer = setTimeout(() => { child.kill(); child.unref(); finish(false); }, 3000);
    } catch { finish(false); }
  });
}
