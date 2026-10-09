import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { assertCheckRegistry } from './check-profile.mjs';
import { containedCheckPath, resolveCheckExecutable } from './check-toolchain.mjs';
import { hostSystemEnvironment } from './host-executables.mjs';

/** Commands originate only in the currently bound local profile, never in AI output. */
export function makeRegisteredCheckCommand({ root, worktree, node, plan, profile }) {
  if (plan.schemaVersion !== 3 || !plan.checks || plan.checkRegistryHash !== hashObject(plan.checks))
    throw new GraphError('CHECK_REGISTRY_MISSING', 'Проверка требует подтвержденный registry текущего плана.');
  const registry = assertCheckRegistry(root, profile, plan.checks);
  const id = node.action.id.slice('check-'.length);
  const definition = registry.definitions.find((check) => check.id === id);
  const binding = registry.bindings.find((check) => check.id === id);
  if (!definition || !binding || !profile.checks.includes(id)) throw new GraphError('CHECK_NOT_CONFIGURED', 'Проверка не включена в согласованный профиль.');
  const executable = resolveCheckExecutable(worktree, definition.command.executable);
  const environment = { ...hostSystemEnvironment(), PATH: [path.dirname(executable.executable), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', ...Object.fromEntries(profile.checkProfile.environment.map(({ name, value }) => [name, value])) };
  // hostSystemEnvironment is needed for process creation, but home/config and ambient PATH are not granted.
  for (const name of Object.keys(environment)) if (/^(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|COMSPEC)$/i.test(name)) delete environment[name];
  return { command: { executable: executable.executable, args: [...definition.command.argv], cwd: containedCheckPath(worktree, definition.command.cwd), env: environment },
    input: '', maxOutputBytes: definition.maxOutputBytes, timeoutMs: definition.timeoutMs,
    execution: { kind: 'registered-check', isolation: 'trusted-project-process', actionId: node.action.id,
      checkRegistryHash: plan.checkRegistryHash, ...binding } };
}
