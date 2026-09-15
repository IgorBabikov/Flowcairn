import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hashObject } from './io.mjs';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ExternalProviderConsentSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum(['claude', 'cursor']),
  planHash: Hash,
  scopeHash: Hash,
  instructionsHash: Hash,
  skillsHash: Hash,
  artifactsHash: Hash,
  transmitted: z.array(z.enum(['approved-scope', 'approved-instructions', 'approved-skills', 'approved-artifacts'])).min(1).max(4),
  excluded: z.array(z.enum(['secrets', 'environment-files', 'git-history', 'unapproved-files', 'project-host-shell'])).min(5).max(5),
}).refine((value) => new Set(value.transmitted).size === value.transmitted.length && new Set(value.excluded).size === value.excluded.length);

export const EXTERNAL_PROVIDER_CONSENT = Object.freeze({
  transmitted: Object.freeze(['approved-scope', 'approved-instructions', 'approved-skills', 'approved-artifacts']),
  excluded: Object.freeze(['secrets', 'environment-files', 'git-history', 'unapproved-files', 'project-host-shell']),
});

/** External execution binds this exact disclosure to an immutable plan and receipt. */
export function externalProviderConsentHash(value) {
  return hashObject(ExternalProviderConsentSchema.parse(value));
}

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
    runtime: Object.freeze({
      status: 'available-after-probe',
      execution: 'restricted-cli-adapter',
      reason: 'Нужны проверка точной версии CLI и отдельное согласие на передачу ограниченного контекста для каждого immutable плана.',
    }),
  }),
  cursor: Object.freeze({
    label: 'Cursor',
    executables: Object.freeze(['agent', 'cursor-agent']),
    pluginManifest: '.cursor-plugin/plugin.json',
    instructions: Object.freeze(['.cursor/rules/', '.cursorrules']),
    skills: Object.freeze(['.cursor/skills/', '.agents/skills/']),
    runtime: Object.freeze({
      status: 'available-after-probe',
      execution: 'isolated-cli-adapter',
      reason: 'CLI запускается только в пустом private workspace с deny-политикой. Его JSON-ответ дополнительно валидируется Flowcairn; нужна точная версия и отдельное согласие.',
    }),
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
      runtime: id === 'codex'
        ? { status: 'available', execution: 'runtime-adapter', reason: null }
        : ('runtime' in descriptor ? descriptor.runtime : { status: 'official-adapter-unavailable', execution: 'disabled', reason: 'Execution adapter не подтвержден.' }),
    };
  });
}
