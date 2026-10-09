import { lstatSync, realpathSync } from 'node:fs';
import { GraphError, hashObject } from './io.mjs';
import { fingerprintDirectWorkspace } from './direct-workspace.mjs';
import { packageCheckShell } from './check-shell.mjs';
import { assertCheckRegistry, isGenericProfile, projectCheckProfile } from './check-profile.mjs';
import { containedCheckPath, inspectCheckInputs, packageCheckConfigHash, resolveCheckExecutable } from './check-toolchain.mjs';

const fail = () => { throw new GraphError('CHECK_REGISTRY_DRIFT', 'Команда или входы фактического каталога проверки изменились до запуска.'); };

function directoryIdentity(directory) {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) fail();
  return { path: directory, device: String(stat.dev), inode: String(stat.ino) };
}

/** One transient authorization snapshot across reservation. Persisted V2/V3 objects are not rewritten. */
export function checkExecutionHash({ root, worktree, profile, node, plan, command }) {
  try {
    const rootIdentity = directoryIdentity(root), workspaceIdentity = directoryIdentity(worktree);
    const definitions = plan.schemaVersion === 3
      ? assertCheckRegistry(root, profile, plan.checks).definitions
      : projectCheckProfile(worktree, { ...profile, checks: [node.action.id.slice('check-'.length)] }).definitions;
    const definition = definitions.find((check) => `check-${check.id}` === node.action.id);
    if (!definition) fail();
    const cwd = containedCheckPath(worktree, definition.command.cwd), cwdIdentity = directoryIdentity(cwd);
    const executable = resolveCheckExecutable(worktree, definition.command.executable);
    if (command.cwd !== cwd || command.executable !== executable.executable ||
        hashObject(command.args) !== hashObject(definition.command.argv)) fail();
    const actualInputs = inspectCheckInputs(worktree, definition.inputPaths);
    if (plan.schemaVersion === 3) {
      const binding = plan.checks.bindings.find((check) => check.id === definition.id);
      const approvedInputs = root === worktree ? actualInputs : inspectCheckInputs(root, definition.inputPaths);
      if (!binding || executable.hash !== binding.executableHash ||
          approvedInputs.hash !== binding.inputManifestHash || actualInputs.portableHash !== approvedInputs.portableHash) fail();
    }
    return hashObject({ rootIdentity, workspaceIdentity, cwdIdentity, profileHash: hashObject(profile),
      commandHash: hashObject(command), definitionHash: hashObject(definition), inputsHash: actualInputs.hash, executable,
      workspaceSourceHash: fingerprintDirectWorkspace(worktree, { outputPaths: profile.outputPaths }).hash,
      scriptShell: isGenericProfile(profile) ? null : packageCheckShell(worktree, profile.packageManager, command),
      configurationHash: isGenericProfile(profile) ? null : packageCheckConfigHash(worktree, profile.packageManager) });
  } catch (error) {
    if (error instanceof GraphError && ['CHECK_REGISTRY_DRIFT', 'CHECK_SHELL_CONFIG_UNSUPPORTED'].includes(error.code)) throw error;
    fail();
  }
}
