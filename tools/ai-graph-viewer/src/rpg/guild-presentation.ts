import { GUILD_ROLES, type GuildRole } from './guild-manifest';
import type { WorldExecutionView, WorldWorker } from './world-execution';

export const GUILD_LABELS: Record<GuildRole, string> = { analyst: 'Рунописец', mage: 'Чародей', checker: 'Следопыт проверок', reviewer: 'Страж ревью', mentor: 'Наставник' };
export function roleWorker(view: WorldExecutionView, role: GuildRole): WorldWorker | null {
  const workers = view.workers.filter(worker => worker.role === role && !worker.historical);
  return workers.find(worker => worker.active) ?? workers.find(worker => ['failed', 'uncertain', 'waiting-for-human', 'learning-hold'].includes(worker.state)) ??
    workers.find(worker => ['ready', 'waiting', 'pending'].includes(worker.state)) ?? workers.at(-1) ?? null;
}
export function workerReply(worker: WorldWorker | null, view: WorldExecutionView): string {
  if (view.freshness === 'disconnected') return 'Актуальное состояние недоступно';
  if (view.freshness === 'stale') return 'Доказательства устарели';
  if (view.freshness === 'history') return 'Сохраненное состояние';
  if (!worker) return 'Нет этапа в этом плане';
  if (worker.active) {
    if (worker.action === 'ai-analyze') return 'Изучаю задачу и проект';
    if (worker.action === 'ai-plan') return 'Готовлю план';
    if (worker.role === 'mage') return worker.attempt > 1 ? 'Исправляю по результатам проверки' : 'Изменяю код';
    if (worker.role === 'checker') return 'Запускаю проверки';
    if (worker.role === 'reviewer') return 'Проверяю изменения';
    return 'Этап выполняется';
  }
  const states: Partial<Record<WorldWorker['state'], string>> = { passed: 'Этап завершен · отчет сохранен',
    failed: 'Этап завершился с ошибкой', uncertain: 'Результат неизвестен', cancelled: 'Работа остановлена',
    'waiting-for-human': 'Жду решения по плану', 'learning-hold': 'Разбор ждет вашего решения',
    waiting: 'Жду зависимости', pending: 'Жду зависимости', ready: 'Этап готов к запуску',
    disconnected: 'Актуальное состояние недоступно', stale: 'Доказательства устарели', history: 'Сохраненный этап', unknown: 'Состояние не определено' };
  return states[worker.state] ?? (view.runtimeStatus === 'uncertain' ? 'Результат неизвестен' : 'Нет активной работы');
}
export function actorAssignments(view: WorldExecutionView): { id: string; role: GuildRole; worker: WorldWorker | null; offset: number }[] {
  const assigned = GUILD_ROLES.map(role => ({ id: role as string, role, worker: roleWorker(view, role), offset: 0 }));
  for (const worker of view.workers.filter(item => item.active && item.role !== 'unknown')) {
    if (assigned.some(item => item.worker?.id === worker.id) || assigned.length >= 6) continue;
    assigned.push({ id: worker.id, role: worker.role as GuildRole, worker, offset: 1 });
  }
  return assigned;
}
