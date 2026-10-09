import { z } from 'zod';

export const Id = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Text = z.string().min(1).max(4000);
export const RelativePath = z
  .string()
  .min(1)
  .max(512)
  // Keep the basic boundary visible in provider JSON Schema as well as in Zod.
  // A simple provider-compatible pattern rejects root and absolute paths;
  // the refinement below remains the full trusted path check.
  .regex(/^(?:[^./\\]|\.[^./\\])[^\\]*$/)
  .refine((value) => {
    if (
      value.includes('\\') ||
      value.includes('\0') ||
      value.startsWith('/') ||
      /^[a-z]:/i.test(value)
    )
      return false;
    return !value
      .replace(/\/$/, '')
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          part.toLowerCase() === '.ai-orchestrator',
      );
  }, 'Expected a contained repository-relative path');
