import { GraphError, hashObject } from './io.mjs';
import { buildTaskContext } from './task-context.mjs';

/** Compatibility entry point; all natural tasks use the same context resolver. */
export function selectDirectTaskScope(description, filePaths, candidates) {
  const result = buildTaskContext({
    fields: { title: '', description, taskNumber: '' },
    project: { contextHash: hashObject(filePaths), scopeCandidates: candidates, contextPaths: [] },
    files: filePaths,
  });
  if (!result.ready) throw new GraphError('INTAKE_SCOPE_UNCLEAR', result.issues.join('\n'));
  return result.scope;
}
