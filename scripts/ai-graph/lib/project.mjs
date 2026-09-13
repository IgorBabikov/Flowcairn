import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { RelativePath } from './schemas.mjs';

export const RUNTIME_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
);
export const PROJECT_PROFILE_FILE = '.flowcairn.json';

const safeProfilePath = RelativePath.refine(
  (value) =>
    !value
      .split('/')
      .some(
        (part) =>
          /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|credentials(?:\.json)?$|id_rsa$|id_ed25519$)/i.test(
            part,
          ) ||
          /\.(?:pem|key|p12|pfx)$/i.test(part) ||
          /(?:^|[._-])secrets?(?:[._-](?:json|ya?ml|toml|txt))?$/i.test(part),
      ),
  'Sensitive paths are not project context',
);
const paths = z
  .array(safeProfilePath)
  .max(32)
  .refine((values) => new Set(values).size === values.length, 'Duplicate paths');
const branch = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')),
  );
const model = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);

/** Trusted local configuration: fixed action names, never executable code or credentials. */
export const ProjectProfileSchema = z.strictObject({
  version: z.literal(1),
  integrationBranch: branch,
  packageManager: z.enum(['npm', 'pnpm']),
  contextPaths: paths,
  checks: z
    .array(z.enum(['typecheck', 'lint', 'tests', 'build']))
    .max(4)
    .refine((values) => new Set(values).size === values.length),
  outputPaths: paths.refine((values) =>
    values.every(
      (value) =>
        !['AGENTS.md', 'README.md', 'package.json', '.flowcairn.json'].some(
          (name) => name === value || name.startsWith(`${value}/`),
        ),
    ),
  ),
  manifests: paths,
  ai: z.strictObject({
    provider: z.enum(['codex', 'openai']),
    model,
    reviewModel: model.optional(),
    codexPath: z
      .string()
      .max(1024)
      .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
      .optional(),
    baseUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      })
      .optional(),
  }),
});

export function loadProjectProfile(root) {
  const canonical = realpathSync(root);
  const file = path.join(canonical, PROJECT_PROFILE_FILE);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new GraphError('PROJECT_PROFILE_MISSING', 'Run flowcairn init to create .flowcairn.json');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) {
    throw new GraphError(
      'PROJECT_PROFILE_UNSAFE',
      '.flowcairn.json must be a bounded regular file without links',
    );
  }
  try {
    return ProjectProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new GraphError(
      'PROJECT_PROFILE_INVALID',
      '.flowcairn.json does not match the strict project profile',
    );
  }
}

export function projectProfileHash(root) {
  return hashObject(loadProjectProfile(root));
}

export function projectContextPaths(root, profile = loadProjectProfile(root)) {
  return [
    ...new Set([
      ...['AGENTS.md', 'README.md'].filter((name) => existsSync(path.join(root, name))),
      ...profile.contextPaths,
      ...profile.manifests.filter((file) => /(?:^|\/)package\.json$/.test(file)),
    ]),
  ];
}
