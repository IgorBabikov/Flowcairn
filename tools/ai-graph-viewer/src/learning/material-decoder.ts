import { decodeCoverage } from './coverage-decoder';
import type { LearningMaterialResponse, LearningSourceResponse, MaterialGap, SavedSource, StageMaterial } from '../contracts';
import { hashContent } from '../plan-identity';
import { assertLearning, record, text, hash, id, integer, nullable, choice, savedSource, uniqueIds, capability, relativePath } from './validation';

function materialCapabilities(value: unknown) {
  return record(value) && ['generateLesson', 'askLesson', 'setLearningProgress'].every(key => capability(value[key]));
}
function gap(value: unknown): value is MaterialGap {
  return record(value) && choice(value.code, ['missing-context', 'size-limit', 'excluded-source', 'capture-unavailable'])
    && nullable(value.path, relativePath) && text(value.reason);
}
function material(value: unknown): value is StageMaterial {
  return record(value) && (value.version === 1 ? value.coverageHash === undefined : value.version === 2 && hash(value.coverageHash)) && choice(value.kind, ['stage', 'task']) && id(value.runId)
    && ['planHash', 'taskHash', 'contractHash', 'beforeHash', 'resultHash', 'sourceCatalogHash'].every(key => hash(value[key]))
    && nullable(value.stageId, id) && (value.kind === 'task' ? value.stageId === null : id(value.stageId))
    && text(value.goal) && text(value.outcome) && text(value.createdAt, 64) && Number.isFinite(Date.parse(value.createdAt))
    && (Array.isArray(value.requirementIds) && value.requirementIds.every(id)) && choice(value.status, ['complete', 'partial', 'unavailable']) && (Array.isArray(value.gaps) && value.gaps.every(gap))
    && ['implementationReceiptIds', 'checkReceiptIds', 'reviewReceiptIds', 'diffArtifactIds', 'findingsArtifactIds'].every(key => (Array.isArray(value[key]) && value[key].every(hash)));
}
export async function decodeLearningMaterial(value: unknown, runId: string, materialHash: string): Promise<LearningMaterialResponse> {
  assertLearning(record(value) && value.id === materialHash && material(value.material) && id(runId)
    && (Array.isArray(value.sources) && value.sources.every(savedSource)) && uniqueIds(value.sources)
    && record(value.freshness) && choice(value.freshness.state, ['current', 'stale', 'unknown']) && nullable(value.freshness.reason, text)
    && choice(value.progress, ['unread', 'read', 'deferred']) && nullable(value.lessonHash, hash) && materialCapabilities(value.capabilities));
  const response = value as unknown as LearningMaterialResponse;
  assertLearning(await hashContent(response.material) === materialHash, 'Хеш сохраненного материала не совпадает с запрошенной версией.');
  let catalogHash: string;
  if (response.sourceCatalog) {
    assertLearning(response.sourceCatalog.version === 2 && Array.isArray(response.sourceCatalog.pageHashes) && response.sourceCatalog.pageHashes.every(hash));
    const pageHashes: string[] = [];
    for (let offset = 0; offset < response.sources.length; offset += 1000)
      pageHashes.push(await hashContent({ version: 1, sources: response.sources.slice(offset, offset + 1000) }));
    assertLearning(JSON.stringify(pageHashes) === JSON.stringify(response.sourceCatalog.pageHashes));
    catalogHash = await hashContent(response.sourceCatalog);
  } else catalogHash = await hashContent({ version: 1, sources: response.sources });
  assertLearning(catalogHash === response.material.sourceCatalogHash, 'Каталог исходников не соответствует сохраненному материалу.');
  await decodeCoverage(response);
  return response;
}

export function decodeLearningSource(value: unknown, source: SavedSource, startLine: number, lineCount: number, startColumn = 0): LearningSourceResponse {
  assertLearning(record(value) && value.sourceId === source.id && value.fileHash === source.fileHash && value.startLine === startLine
    && integer(value.endLine) && value.totalLines === source.lineCount && typeof value.text === 'string'
    && new TextEncoder().encode(value.text).length <= 65536);
  assertLearning((value.startColumn ?? 0) === startColumn);
  if (startColumn || value.partial === true) assertLearning(integer(value.endColumn, startColumn)
    && value.endColumn === startColumn + (value.text.split('\n')[0]?.length ?? 0));
  const empty = source.lineCount === 0;
  assertLearning(empty ? startLine === 1 && value.endLine === 0 && value.text === '' && value.next === null
    : value.endLine >= startLine && value.endLine < startLine + lineCount && value.endLine <= source.lineCount
      && value.text.split('\n').length === value.endLine - startLine + 1);
  if (value.partial === true) {
    assertLearning(value.startColumn === startColumn && integer(value.endColumn, startColumn + 1)
      && value.endLine === startLine && value.text.length === value.endColumn - startColumn
      && record(value.next) && value.next.startLine === startLine && value.next.startColumn === value.endColumn
      && integer(value.next.lineCount, 1, 200));
  } else if (value.endLine < source.lineCount) {
    assertLearning(record(value.next) && value.next.startLine === value.endLine + 1 && integer(value.next.lineCount, 1, 200));
  } else assertLearning(value.next === null);
  return value as unknown as LearningSourceResponse;
}
