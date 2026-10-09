import type { AskLesson, LearningCommandResponse, LearningJob, LearningMaterialResponse, LessonAnswer, Snapshot } from '../contracts';
import { isSnapshot } from '../contracts';
import { hashContent } from '../plan-identity';
import { learningRun } from './learning-projection';
import { anchorInCatalog, assertLearning, choice, hash, id, list, record, sourceAnchor, text } from './validation';

export function decodeLearningCommand(value: unknown, runId: string): LearningCommandResponse {
  if (!record(value) || value.ok !== true || !record(value.result) || !id(value.result.jobId)
    || !isSnapshot(value.result.snapshot) || value.result.snapshot.runId !== runId || !learningRun(value.result.snapshot)) {
    // The write may already have committed. Keep the original operation for an exact replay.
    throw {code:'LEARNING_RESPONSE_UNCERTAIN',message:'Ответ учебной команды поврежден. Результат неизвестен; повторите тот же запрос.',retryable:true};
  }
  return value.result as unknown as LearningCommandResponse;
}
export function decodeProgressResponse(value: unknown, runId: string): Snapshot {
  if (!record(value) || value.ok !== true || !isSnapshot(value.result) || value.result.runId !== runId || !learningRun(value.result)) {
    throw {code:'LEARNING_RESPONSE_UNCERTAIN',message:'Не удалось подтвердить отметку чтения. Повторите тот же запрос.',retryable:true};
  }
  return value.result;
}
export function decodeLearningJob(value: unknown, jobId: string, materialHash: string, kind: 'lesson' | 'question'): LearningJob {
  assertLearning(record(value) && value.id === jobId && value.materialHash === materialHash && value.kind === kind
    && choice(value.status,['running','ready','failed','uncertain']) && (value.error === null || record(value.error) && text(value.error.code,80) && text(value.error.message)));
  assertLearning(value.result === null || record(value.result) && (kind === 'lesson' ? hash(value.result.lessonHash) : hash(value.result.answerHash)));
  assertLearning(value.status !== 'ready' || value.result !== null,'Сервис сообщил о готовности, но не передал ссылку на учебный результат.');
  return value as unknown as LearningJob;
}
export async function decodeLearningAnswer(value: unknown, answerHash: string, material: LearningMaterialResponse, expected?: Pick<AskLesson,'lessonHash'|'anchor'|'question'>): Promise<LessonAnswer> {
  assertLearning(record(value) && value.version === 1 && value.materialHash === material.id && hash(value.lessonHash) && value.lessonHash === material.lessonHash
    && sourceAnchor(value.anchor) && text(value.question,4000) && text(value.text,16000) && list(value.anchors,sourceAnchor,32) && list(value.limitations,text,32));
  const answer=value as unknown as LessonAnswer;
  assertLearning(await hashContent(answer)===answerHash,'Хеш ответа не совпадает с сохраненным результатом.');
  assertLearning([answer.anchor,...answer.anchors].every(anchor=>anchorInCatalog(anchor,material.sources)),'Ответ ссылается на другую версию исходников.');
  if(expected) assertLearning(answer.lessonHash===expected.lessonHash && answer.question===expected.question
    && await hashContent(answer.anchor)===await hashContent(expected.anchor),'Ответ относится к другому вопросу или фрагменту.');
  return answer;
}
