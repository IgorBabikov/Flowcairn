import path from 'node:path';

export const MAX_CONTROL_BYTES = 256 * 1024;
export const MAX_CONTROL_INPUT_BYTES = 128 * 1024;
// A scoped filesystem policy can exceed 16 KiB in a large project. Keep the
// argument bounded while allowing the full set of explicit read/deny paths.
export const MAX_CONTROL_ARG_CHARS = 32 * 1024;

export function validCommand(command) {
  return Boolean(
    command &&
    typeof command === 'object' &&
    Object.getPrototypeOf(command) === Object.prototype &&
    typeof command.executable === 'string' &&
    path.isAbsolute(command.executable) &&
    Array.isArray(command.args) &&
    command.args.length <= 1_000 &&
    command.args.every((item) => typeof item === 'string' && item.length <= MAX_CONTROL_ARG_CHARS) &&
    typeof command.cwd === 'string' &&
    path.isAbsolute(command.cwd) &&
    command.env &&
    typeof command.env === 'object' &&
    Object.getPrototypeOf(command.env) === Object.prototype &&
    Object.entries(command.env).every(
      ([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string',
    )
  );
}
