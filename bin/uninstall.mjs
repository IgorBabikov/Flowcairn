import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GraphError, sha256 } from '../scripts/ai-graph/lib/io.mjs';

const OWNER = '.ai-orchestrator/flowcairn-install.json';
const IGNORE_BLOCK = '# Flowcairn: локальное состояние, не исходники\n.ai-orchestrator/\n';
const LOCAL_EXCLUDE = '.git/info/exclude';

function inspectFile(root, relative) {
  const file = path.join(root, relative);
  let cursor = root;
  for (const part of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new GraphError('UNINSTALL_UNSAFE_FILE', 'Путь установки содержит ссылку или неожиданный тип файла.');
  }
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new GraphError('UNINSTALL_UNSAFE_FILE', 'Файл установки должен быть ограниченным обычным файлом без ссылок.');
    const bytes = readFileSync(fd);
    if (bytes.length > 1024 * 1024) throw new GraphError('UNINSTALL_UNSAFE_FILE', 'Файл установки превышает лимит.');
    return { relative, bytes, hash: sha256(bytes), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

function same(a, b) {
  return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino && a.hash === b.hash;
}

function ownedPlan(root) {
  const receipt = inspectFile(root, OWNER);
  if (!receipt) return { changes: [], remaining: [], receipt: null };
  let owner;
  try { owner = JSON.parse(receipt.bytes.toString('utf8')); }
  catch { throw new GraphError('UNINSTALL_OWNER', 'Поврежден receipt установки; файлы сохранены.'); }
  if (owner.tool !== 'flowcairn' || !/^flowcairn-[a-f0-9-]+$/.test(owner.owner ?? ''))
    throw new GraphError('UNINSTALL_OWNER', 'Ownership установки не подтвержден.');
  const changes = [], remaining = [];
  let packageManager;
  for (const [relative, owned, hash] of [
    ['.flowcairn.json', owner.profileOwned === true, owner.profileHash],
  ]) {
    const current = inspectFile(root, relative);
    if (!current) continue;
    if (relative === '.flowcairn.json') {
      try {
        const configured = JSON.parse(current.bytes.toString('utf8')).packageManager;
        if (['npm', 'pnpm', 'yarn'].includes(configured)) packageManager = configured;
      } catch {
        if (owned) throw new GraphError('UNINSTALL_MODIFIED_FILE', 'Профиль изменен или поврежден; файлы сохранены.');
      }
    }
    if (!owned) { remaining.push(relative); continue; }
    if (current.hash !== hash)
      throw new GraphError('UNINSTALL_MODIFIED_FILE', `${relative} изменен после установки; автоматическое удаление остановлено.`);
    changes.push({ current, desired: null });
  }
  const localExclude = inspectFile(root, LOCAL_EXCLUDE);
  if (localExclude && owner.localExcludeBlockOwned === true) {
    const text = localExclude.bytes.toString('utf8');
    const count = text.split(IGNORE_BLOCK).length - 1;
    const alreadyRestored = count === 0 && text === owner.localExcludeBefore;
    if (count !== 1 && !alreadyRestored)
      throw new GraphError('UNINSTALL_MODIFIED_FILE', 'Управляемое локальное Git-исключение изменено или продублировано; файлы сохранены.');
    const desired = localExclude.hash === owner.localExcludeAfterHash
      ? owner.localExcludeBefore
      : text.replace(IGNORE_BLOCK, '');
    if (typeof desired !== 'string')
      throw new GraphError('UNINSTALL_OWNER', 'Исходное состояние локального Git-исключения не подтверждено.');
    if (!alreadyRestored) changes.push({ current: localExclude, desired });
  }
  // Receipts from flowcairn <= 0.2.5 may still own a project .gitignore block.
  const ignore = inspectFile(root, '.gitignore');
  if (ignore && owner.ignoreBlockOwned === true) {
    const text = ignore.bytes.toString('utf8');
    const count = text.split(IGNORE_BLOCK).length - 1;
    const alreadyRestored = count === 0 && typeof owner.ignoreBefore === 'string' && text === owner.ignoreBefore;
    if (count !== 1 && !alreadyRestored)
      throw new GraphError('UNINSTALL_MODIFIED_FILE', 'Управляемый блок .gitignore изменен или продублирован; файлы сохранены.');
    const desired = ignore.hash === owner.ignoreAfterHash
      ? owner.ignoreBefore
      : text.replace(IGNORE_BLOCK, '');
    if (desired !== null && typeof desired !== 'string')
      throw new GraphError('UNINSTALL_OWNER', 'Исходное состояние .gitignore не подтверждено.');
    if (!alreadyRestored) changes.push({ current: ignore, desired });
  }
  changes.push({ current: receipt, desired: null });
  return { changes, remaining, receipt, packageManager };
}

function applyChange(root, change) {
  const { current, desired } = change;
  if (!same(current, inspectFile(root, current.relative)))
    throw new GraphError('UNINSTALL_CONCURRENT_CHANGE', 'Файлы изменились во время удаления; дальнейшие записи остановлены.');
  const target = path.join(root, current.relative);
  if (desired === null) { unlinkSync(target); return; }
  const temp = `${target}.flowcairn-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, desired, { flag: 'wx', mode: current.mode });
    if (!same(current, inspectFile(root, current.relative)))
      throw new GraphError('UNINSTALL_CONCURRENT_CHANGE', 'Файлы изменились во время удаления; дальнейшие записи остановлены.');
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch { /* Do not mask a concurrent-change error with cleanup failure. */ }
  }
}

function preserveStateIgnore(root, plan, guard, integration) {
  const removable = new Set(plan.changes.map((item) => item.current.relative));
  for (const entry of integration.ownedArtifacts ?? []) {
    if (entry.path === '.ai-orchestrator/flowcairn-integration.json') removable.add(entry.path);
  }
  // Only the trusted lifecycle adapter can designate its validated temporary fence/receipts.
  for (const transient of guard.transientPaths ?? []) removable.add(transient);
  let names;
  try { names = readdirSync(path.join(root, '.ai-orchestrator')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!names.some((name) => !removable.has(`.ai-orchestrator/${name}`))) return;
  const ownsIgnore = plan.changes.some((item) =>
    ['.gitignore', LOCAL_EXCLUDE].includes(item.current.relative),
  );
  if (!ownsIgnore) return;
  plan.changes = plan.changes.filter((item) => !['.gitignore', LOCAL_EXCLUDE, OWNER].includes(item.current.relative));
  plan.remaining.push('локальное Git-исключение (сохранено правило для приватного состояния)', OWNER);
}

const defaultLoader = async () => ({
  ...await import('../scripts/ai-graph/lib/integration.mjs'),
  ...await import('../scripts/ai-graph/lib/uninstall.mjs'),
  ...await import('../scripts/ai-graph/lib/lifecycle.mjs'),
});

/** Shared lifecycle fence plus exact owned-file cleanup. User content/results remain intact. */
export async function uninstallCommand(projectRoot, options = {}, loader = defaultLoader) {
  const root = realpathSync(projectRoot);
  const api = await loader();
  const guard = await api.acquireUninstallGuard({ root });
  let result;
  let packageManifest = null;
  let packageUnknown = false;
  try {
    const pkg = inspectFile(root, 'package.json');
    if (pkg) {
      try {
        packageManifest = JSON.parse(pkg.bytes.toString('utf8'));
        if (!packageManifest || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) packageUnknown = true;
      } catch { packageUnknown = true; }
    }
    const plan = ownedPlan(root);
    const contract = { projectRoot: root, processProbe: guard.processProbe, worktreePaths: guard.worktreePaths };
    const safety = api.assertUninstallSafe(contract);
    const integration = api.inspectIntegration({ projectRoot: root });
    if (!['active', 'inactive'].includes(integration.status))
      throw new GraphError('UNINSTALL_INTEGRATION_CONFLICT', 'Интеграция изменена, неполна или перекрыта другим файлом инструкций; файлы сохранены.');
    preserveStateIgnore(root, plan, guard, integration);
    if (options['dry-run']) return {
      dryRun: true, removed: false, canRemove: true, safety, integration,
      changes: plan.changes.map((item) => item.current.relative),
      remaining: plan.remaining,
      message: 'Предварительная проверка. Зависимости, worktrees и результаты не удаляются.',
    };
    const changes = [];
    let deactivated;
    try {
      deactivated = api.uninstallIntegration(contract);
      for (const change of [...plan.changes]) {
        if (['.gitignore', LOCAL_EXCLUDE, OWNER].includes(change.current.relative)) {
          preserveStateIgnore(root, plan, guard, api.inspectIntegration({ projectRoot: root }));
          if (!plan.changes.includes(change)) continue;
        }
        const proof = guard.processProbe();
        if (proof.state !== 'stopped' || proof.verified !== true)
          throw new GraphError('UNINSTALL_PROCESS_CHANGED', 'Lifecycle изменился; дальнейшие записи остановлены.');
        applyChange(root, change);
        changes.push(change.current.relative);
      }
      result = { changed: Boolean(deactivated.changed || changes.length), removed: changes, integration: deactivated, remaining: plan.remaining, packageManager: plan.packageManager, packageRemovalCommand: null };
    } catch (error) {
      if (changes.length || deactivated?.changed) throw new GraphError('UNINSTALL_PARTIAL', `Часть интеграции удалена; дальнейшие изменения остановлены. Измененные owned-файлы: ${changes.join(', ') || 'managed instructions'}. Повторите preview.`, { removed: changes, integrationChanged: Boolean(deactivated?.changed), cause: error.code });
      throw error;
    }
  } finally { await guard.release(); }
  // Only remove a truly empty local state directory, never recursive state/worktree deletion.
  try { rmdirSync(path.join(root, '.ai-orchestrator')); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  const stateDirectory = path.join(root, '.ai-orchestrator');
  try { if (readdirSync(stateDirectory).length) result.remaining.push('.ai-orchestrator/ (сохраненные состояние, результаты или worktrees)'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (inspectFile(root, '.flowcairn.json') && !result.remaining.includes('.flowcairn.json'))
    result.remaining.push('.flowcairn.json');
  if (packageUnknown) result.remaining.push('package.json (состояние зависимостей не удалось проверить)');
  else if (packageManifest) {
    const manifest = packageManifest;
    if (['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => Object.hasOwn(manifest[field] ?? {}, 'flowcairn'))) {
      result.remaining.push('flowcairn dependency в package.json и lockfile (устанавливалась вне init)');
      const manager = result.packageManager ?? (typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : 'npm');
      result.packageRemovalCommand = manager === 'npm' ? 'npm uninstall flowcairn' : ['pnpm', 'yarn'].includes(manager) ? `${manager} remove flowcairn` : null;
    }
  }
  return { ...result, status: result.remaining.length ? 'partial' : 'complete', message: result.remaining.length ? 'Owned-интеграция снята. Сохраненные остатки перечислены отдельно; пакет при необходимости удалите своим менеджером.' : 'Owned-интеграция flowcairn удалена. Файлы проекта сохранены.' };
}
