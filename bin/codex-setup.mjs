import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { inspectCodexInstallation, loginCodex } from '../scripts/ai-graph/lib/runner.mjs';
import { ensureManagedRuntime } from '../scripts/ai-graph/lib/managed-runtime.mjs';

export function requireCodexReady(cli) {
  if (cli.available) return;
  const messages = {
    CODEX_AUTH_REQUIRED: 'Codex установлен. Для входа запустите npx flowcairn в обычном терминале; мастер откроет авторизацию.',
    RUNNER_TOOLCHAIN_CAPABILITY: 'Codex не поддерживает обязательные параметры запуска. Обновите Flowcairn или проверьте явно выбранный CLI.',
    RUNNER_TOOLCHAIN_VERSION: 'Для Flowcairn нужен Node.js 22.',
  };
  throw new GraphError(cli.reason ?? 'RUNNER_TOOLCHAIN_INVALID', messages[cli.reason] ?? 'Не удалось проверить Codex CLI. Повторите установку Flowcairn с optional dependencies или проверьте явно выбранный путь. Настройка не сохранена.');
}

/** Invoked only from interactive onboarding, never from install hooks or doctor. */
export async function prepareCodex(ai, { ask, output, probe = inspectCodexInstallation, login = loginCodex, autoUpdate = false }) {
  const managed = ai.codexPath || probe !== inspectCodexInstallation ? null : await ensureManagedRuntime('codex', { autoUpdate });
  const effectiveAi = managed?.executable ? { ...ai, codexPath: managed.executable } : ai;
  let cli = probe(effectiveAi);
  if (!cli.available && cli.reason === 'CODEX_AUTH_REQUIRED') {
    output.write('Codex установлен. Войдите в свой аккаунт через официальный клиент; Flowcairn не получает пароль.\n');
    const answer = (await ask('Открыть вход в Codex? [Enter — да / нет]: ', 'да')).toLowerCase();
    if (!['да', 'yes'].includes(answer)) requireCodexReady(cli);
    await login(effectiveAi);
    cli = probe(effectiveAi);
  }
  requireCodexReady(cli);
  return { ...cli, ...(effectiveAi.codexPath ? { executable: effectiveAi.codexPath } : {}), managed: managed !== null };
}
