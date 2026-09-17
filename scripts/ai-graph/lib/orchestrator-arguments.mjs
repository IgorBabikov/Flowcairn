import { CliError } from './orchestrator-task-contract.mjs';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', `Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

export function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('MISSING_ARGUMENT', `--${key} is required`);
  }
  return value.trim();
}

export function positiveInteger(options, key) {
  const raw = required(options, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError('INVALID_ARGUMENT', `--${key} must be a positive integer`);
  }
  return value;
}

export function nonNegativeInteger(options, key) {
  const raw = required(options, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliError('INVALID_ARGUMENT', `--${key} must be a non-negative integer`);
  }
  return value;
}
