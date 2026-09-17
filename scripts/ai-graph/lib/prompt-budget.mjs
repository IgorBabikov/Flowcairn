import { GraphError } from './io.mjs';
import { isWithin } from './registry.mjs';

/** Fit the actual rendered request by removing only redundant or auxiliary context. */
export function fitPromptBudget({ task, node, priorEvidence, render,
  measure = (prompt) => Buffer.byteLength(prompt), maxBytes = 128 * 1024,
  errorCode = 'RUNNER_PROMPT_LIMIT', errorMessage = 'AI prompt превышает лимит' }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024)
    throw new GraphError('RUNNER_PROMPT_LIMIT', 'Лимит prompt можно только уменьшить');
  const selected = priorEvidence == null ? null : structuredClone(priorEvidence);
  if (task.planningFeedback?.length && selected?.feedback &&
      JSON.stringify(selected.feedback) === JSON.stringify(task.planningFeedback)) delete selected.feedback;
  let prompt = render(selected);
  const fits = () => measure(prompt) <= maxBytes;
  if (fits()) return { prompt, priorEvidence: selected };
  for (const artifact of selected?.artifacts ?? []) {
    if (typeof artifact.excerpt !== 'string' || !artifact.excerpt.length) continue;
    delete artifact.excerpt;
    artifact.truncated = true;
    prompt = render(selected);
    if (fits()) return { prompt, priorEvidence: selected };
  }
  const files = selected?.workspaceFiles ?? [];
  for (let index = files.length - 1; index >= 0; index--) {
    // Implementation needs the current hashes for proposed writes. Read-only work does not.
    if (node?.action?.id === 'ai-implement' && node.resources.writes.some((scope) => isWithin(files[index].path, scope))) continue;
    files.splice(index, 1);
    selected.workspaceFilesTruncated = true;
    prompt = render(selected);
    if (fits()) return { prompt, priorEvidence: selected };
  }
  throw new GraphError(errorCode, errorMessage);
}
