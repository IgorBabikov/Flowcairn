import { spawn } from 'node:child_process';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { ensureManagedRuntime } from '../scripts/ai-graph/lib/managed-runtime.mjs';
import { probeExternalProvider } from '../scripts/ai-graph/lib/providers.mjs';
import { providerEnvironment } from '../scripts/ai-graph/lib/provider-process-platform.mjs';

async function login(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['auth', 'login'], { stdio: 'inherit', env: providerEnvironment(), shell: false });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.once('error', () => { clearTimeout(timeout); reject(new GraphError('PROVIDER_AUTH_REQUIRED', 'Не удалось открыть вход в Claude Code. Повторите npx flowcairn.')); });
    child.once('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(undefined) : reject(new GraphError('PROVIDER_AUTH_REQUIRED', 'Вход в Claude Code не завершен. Повторите npx flowcairn.')); });
  });
}

/** @param {{ask: (text: string, fallback: string) => Promise<string>, output: {write: (value: string) => void}, executable?: string, autoUpdate?: boolean}} options */
export async function prepareClaude(options) {
  const { ask, output, executable, autoUpdate = false } = options;
  const managed = executable ? null : await ensureManagedRuntime('claude', { autoUpdate });
  const selected = executable ?? managed?.executable;
  let probe = probeExternalProvider('claude', { executable: selected });
  if (!probe.available && probe.reason === 'PROVIDER_AUTH_REQUIRED') {
    output.write('Claude Code установлен. Войдите в свой аккаунт через официальный клиент; Flowcairn не получает пароль.\n');
    const answer = (await ask('Открыть вход в Claude Code? [Enter — да / нет]: ', 'да')).toLowerCase();
    if (!['да', 'yes'].includes(answer)) throw new GraphError('PROVIDER_AUTH_REQUIRED', 'Claude Code не авторизован. Повторите вход в CLI.');
    await login(probe.executable ?? selected);
    probe = probeExternalProvider('claude', { executable: probe.executable ?? selected });
  }
  if (!probe.available) throw new GraphError(probe.reason, 'Claude Code не прошел проверку. Повторите установку Flowcairn или вход в CLI.');
  return { ...probe, managed: managed !== null || probe.managed === true };
}
