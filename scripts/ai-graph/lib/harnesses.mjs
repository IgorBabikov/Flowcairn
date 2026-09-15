import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const HARNESS_DESCRIPTORS = Object.freeze({
  codex: Object.freeze({
    label: 'Codex',
    executables: Object.freeze(['codex']),
    pluginManifest: '.codex-plugin/plugin.json',
    instructions: Object.freeze(['AGENTS.override.md', 'AGENTS.md']),
    skills: Object.freeze(['.agents/skills/']),
  }),
  claude: Object.freeze({
    label: 'Claude Code',
    executables: Object.freeze(['claude']),
    pluginManifest: '.claude-plugin/plugin.json',
    instructions: Object.freeze(['CLAUDE.md', '.claude/rules/']),
    skills: Object.freeze(['.claude/skills/']),
  }),
  cursor: Object.freeze({
    label: 'Cursor',
    executables: Object.freeze(['cursor-agent']),
    pluginManifest: '.cursor-plugin/plugin.json',
    instructions: Object.freeze(['.cursor/rules/', '.cursorrules']),
    skills: Object.freeze(['.cursor/skills/', '.agents/skills/']),
  }),
});

function regularExecutable(candidate) {
  try {
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    return stat.isFile() && !lstatSync(candidate).isDirectory() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function executablePaths(name, env) {
  return String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name));
}

/** Local-only capability discovery. A detected CLI is never treated as an execution approval. */
export function inspectHarnesses({ env = process.env } = {}) {
  return Object.entries(HARNESS_DESCRIPTORS).map(([id, descriptor]) => {
    const executable = descriptor.executables
      .flatMap((name) => executablePaths(name, env))
      .find(regularExecutable) ?? null;
    return {
      id,
      label: descriptor.label,
      detected: executable !== null,
      ...(executable ? { executable: realpathSync(executable) } : {}),
      pluginManifest: descriptor.pluginManifest,
      instructions: descriptor.instructions,
      skills: descriptor.skills,
      execution: id === 'codex' ? 'runtime-adapter' : 'integration-only',
    };
  });
}
