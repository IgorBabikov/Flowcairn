import type { LearningMaterialResponse, SavedSource, GenerateLesson, AskLesson, SetLearningProgress } from '../contracts';
import { assertLearning, hash, id, integer } from './validation';
import { decodeLearningMaterial, decodeLearningSource } from './material-decoder';
import { decodeLearningCommand, decodeProgressResponse, decodeLearningJob, decodeLearningAnswer } from './job-decoder';
import { decodeLearningLesson } from './lesson-decoder';

type ReadJson = (url: string, init?: RequestInit) => Promise<unknown>;
function materialUrl(runId: string, materialHash: string) {
  assertLearning(id(runId) && hash(materialHash), 'Некорректная ссылка на сохраненный материал.');
  return `/api/runs/${encodeURIComponent(runId)}/learning/materials/${materialHash}`;
}
const readOptions = (signal?: AbortSignal): RequestInit => signal ? { signal } : {};

/** Uses the existing authenticated JSON transport; writes are explicit commands only. */
export function createLearningApi(read: ReadJson) {
  const commandUrl = (runId: string, action: string) => {
    assertLearning(id(runId), 'Некорректный контекст учебной команды.');
    return `/api/runs/${encodeURIComponent(runId)}/learning/commands/${action}`;
  };
  const post = (url: string, body: unknown) => read(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    async generateLesson(runId: string, request: GenerateLesson) {
      return decodeLearningCommand(await post(commandUrl(runId,'generate-lesson'),request),runId);
    },
    async askLesson(runId: string, request: AskLesson) {
      return decodeLearningCommand(await post(commandUrl(runId,'ask-lesson'),request),runId);
    },
    async setLearningProgress(runId: string, request: SetLearningProgress) {
      return decodeProgressResponse(await post(commandUrl(runId,'set-progress'),request),runId);
    },
    async learningJob(runId: string, jobId: string, materialHash: string, kind: 'lesson' | 'question', signal?: AbortSignal) {
      assertLearning(id(runId) && id(jobId) && hash(materialHash));
      return decodeLearningJob(await read(`/api/runs/${encodeURIComponent(runId)}/learning/jobs/${jobId}`,readOptions(signal)),jobId,materialHash,kind);
    },
    async learningAnswer(runId: string, answerHash: string, material: LearningMaterialResponse, expected?: Pick<AskLesson,'lessonHash'|'anchor'|'question'>, signal?: AbortSignal) {
      assertLearning(id(runId) && hash(answerHash));
      return decodeLearningAnswer(await read(`/api/runs/${encodeURIComponent(runId)}/learning/answers/${answerHash}`,readOptions(signal)),answerHash,material,expected);
    },
    async learningMaterial(runId: string, materialHash: string, signal?: AbortSignal) {
      return decodeLearningMaterial(await read(materialUrl(runId, materialHash), readOptions(signal)), runId, materialHash);
    },
    async learningSource(runId: string, materialHash: string, source: SavedSource, startLine = 1, lineCount = 100, signal?: AbortSignal, startColumn = 0) {
      assertLearning(id(source.id) && integer(startLine, 1, Math.max(1, source.lineCount)) && integer(lineCount, 1, 200) && integer(startColumn), 'Некорректный диапазон сохраненного исходника.');
      const url = `${materialUrl(runId, materialHash)}/sources/${encodeURIComponent(source.id)}?startLine=${startLine}&lineCount=${lineCount}${startColumn ? `&startColumn=${startColumn}` : ''}`;
      return decodeLearningSource(await read(url, readOptions(signal)), source, startLine, lineCount, startColumn);
    },
    async learningLesson(runId: string, lessonHash: string, material: LearningMaterialResponse, signal?: AbortSignal) {
      assertLearning(id(runId) && hash(lessonHash) && hash(material.id) && material.lessonHash === lessonHash, 'Разбор не связан с выбранным материалом.');
      return decodeLearningLesson(await read(`/api/runs/${encodeURIComponent(runId)}/learning/lessons/${lessonHash}`, readOptions(signal)), lessonHash, material);
    },
  };
}
