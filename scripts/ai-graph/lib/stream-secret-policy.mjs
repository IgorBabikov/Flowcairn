import { hasSecretContent, normalizeSecretText } from './source-policy.mjs';

const TAIL_CHARS = 4096;
/** Incremental, conservative version of the common secret policy.
 * Whitespace/backslash runs are compacted before inspection. An unresolved
 * credential-like token crossing the retained window is denied, never trusted.
 * Normal file size and long ordinary lines do not cause denial.
 */
export function createSecretContentScanner() {
  let rawTail = '', tail = '', denied = false;
  const inspect = (raw) => {
    const normalized = normalizeSecretText(raw);
    const text = (tail + normalized).replace(/\s+/gu, (space) => /[\r\n]/u.test(space) ? '\n' : ' ');
    denied ||= hasSecretContent(text);
    if (text.length > TAIL_CHARS) {
      const dropped = text;
      // These common-policy patterns have unbounded token lengths. Preserve
      // fail-closed behavior even when a delimiter is arbitrarily far away.
      denied ||= /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}$/u.test(dropped)
        || /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@]+$/iu.test(dropped);
    }
    tail = text.slice(-TAIL_CHARS);
  };
  return {
    update(text) {
      // The policy decodes any run of slashes before an escape; compacting
      // them also prevents a stretched escape from discarding its prefix.
      const raw = (rawTail + text).replace(/\\+/gu, '\\');
      const end = Math.max(0, raw.length - 8);
      let cut = end;
      const slash = raw.lastIndexOf('\\', end);
      if (slash >= end - 5 && slash >= 0) cut = slash;
      inspect(raw.slice(0, cut)); rawTail = raw.slice(cut);
      return denied;
    },
    finish() { inspect(rawTail); rawTail = ''; return denied; },
  };
}
