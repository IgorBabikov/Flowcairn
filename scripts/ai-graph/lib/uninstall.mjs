import { gitExecutable, hostNullDevice } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import { canonicalInstructionRoot, inspectInstructions, instructionError } from './instructions.mjs';
import { INTEGRATION_JOURNAL, inspectIntegration, ownedBlockRange, readIntegrationJournal, readIntegrationTarget, replaceIntegrationFile, withIntegrationLock, writeIntegrationJournal } from './integration.mjs';

function git(root, args, allowNonAncestor = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: hostNullDevice, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const result = spawnSync(gitExecutable(), ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!result.error && result.status === 1 && allowNonAncestor) return null;
  if (result.error || result.status !== 0) instructionError('UNINSTALL_WORKTREE_UNKNOWN', 'Worktree state could not be verified; preserve it and resolve before uninstall.');
  return result.stdout.trim();
}
/** The installer supplies its trusted, live process probe and owned worktree inventory.
 * These are not client JSON assertions. No process is killed and no worktree is removed here.
 */
export function assertUninstallSafe({ projectRoot, processProbe, worktreePaths }) {
  const root = canonicalInstructionRoot(projectRoot);
  if (typeof processProbe !== 'function') instructionError('UNINSTALL_PROCESS_UNKNOWN', 'A live installer process probe is required before uninstall.');
  const proof = processProbe();
  if (!proof || proof.state !== 'stopped' || proof.verified !== true || typeof proof.evidence !== 'string' || !proof.evidence.trim()) instructionError('UNINSTALL_PROCESS_UNKNOWN', 'Active or unknown process state: stop flowcairn normally and verify before uninstall.');
  if (!Array.isArray(worktreePaths) || worktreePaths.length > 128 || worktreePaths.some((entry) => typeof entry !== 'string')) instructionError('UNINSTALL_WORKTREE_UNKNOWN', 'A bounded installer-owned worktree inventory is required.');
  const checked = [];
  for (const candidate of new Set(worktreePaths)) {
    const worktree = canonicalInstructionRoot(candidate);
    if (worktree === root) instructionError('UNINSTALL_WORKTREE_UNKNOWN', 'Project root cannot be presented as a disposable worktree.');
    if (git(worktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']).length) instructionError('UNINSTALL_DIRTY_WORKTREE', 'A worktree has changed, untracked or ignored files; preserve or integrate its work before uninstall.');
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const projectHead = git(root, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(projectHead)) instructionError('UNINSTALL_WORKTREE_UNKNOWN', 'Worktree revision is unknown.');
    if (git(root, ['merge-base', '--is-ancestor', head, projectHead], true) === null) instructionError('UNINSTALL_UNINTEGRATED_WORKTREE', 'A worktree contains commits not integrated into the project HEAD; integrate or preserve them before uninstall.');
    checked.push({ path: worktree, head, status: 'clean-and-integrated' });
  }
  return { process: { state: 'stopped', verified: true }, worktrees: checked, deletesWorktrees: false };
}
/** Removes only the owned instruction block and its journal. Package/profile/ignore ownership
 * belongs to the installer, which must include this result in its complete uninstall transaction.
 */
export function uninstallIntegration({ projectRoot, processProbe, worktreePaths }) {
  const root = canonicalInstructionRoot(projectRoot);
  const safety = assertUninstallSafe({ projectRoot: root, processProbe, worktreePaths });
  const before = inspectInstructions({ projectRoot: root });
  const owned = readIntegrationJournal(root);
  if (!owned) {
    const status = inspectIntegration({ projectRoot: root });
    if (status.status !== 'inactive') instructionError('INTEGRATION_CONFLICT', 'Unowned managed content exists; it will not be removed.');
    return { changed: false, status: 'inactive', fingerprint: before.fingerprint, removedArtifacts: [], safety };
  }
  return withIntegrationLock(root, () => {
    const current = readIntegrationJournal(root);
    if (!current || current.snapshot.sha256 !== owned.snapshot.sha256 || current.value.phase !== 'complete') instructionError('INTEGRATION_CONFLICT', 'Integration journal changed or is incomplete; inspect it before uninstall.');
    const { value } = current;
    const target = readIntegrationTarget(root, value.target);
    if (!target) instructionError('INTEGRATION_MODIFIED', 'Owned instruction target is missing; journal retained.');
    const range = ownedBlockRange(target.bytes, value);
    const preserved = Buffer.concat([target.bytes.subarray(0, range.start), target.bytes.subarray(range.end)]);
    assertUninstallSafe({ projectRoot: root, processProbe, worktreePaths });
    const removing = writeIntegrationJournal(root, { ...value, phase: 'removing' }, current.snapshot);
    replaceIntegrationFile(root, value.target, value.createdFile && preserved.length === 0 ? null : preserved, target);
    replaceIntegrationFile(root, INTEGRATION_JOURNAL, null, removing, 16384);
    const after = inspectInstructions({ projectRoot: root });
    return { changed: true, status: 'inactive', previousFingerprint: before.fingerprint, fingerprint: after.fingerprint, invalidatesActivePlans: true,
      removedArtifacts: [INTEGRATION_JOURNAL], preservedUserBytes: true, safety,
      remaining: 'Installer must separately remove only its unchanged profile/ignore/dependency artifacts; runtime state, results and all worktrees are preserved by this module.' };
  });
}
