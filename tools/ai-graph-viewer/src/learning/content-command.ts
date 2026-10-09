import type { Capability, LearningMaterialResponse, LearningProgress, Snapshot, SourceAnchor } from '../contracts';
import type { PendingLearningOperation } from '../control-operations';
import { learningCapability, learningRun } from './learning-projection';
import { anchorInCatalog, hash, sourceAnchor } from './validation';

export type ContentIntent = { action:'generate-lesson' } | {action:'ask-lesson';lessonHash:string;anchor:SourceAnchor;question:string}
  | {action:'set-progress';progress:LearningProgress};
export function contentCapability(snapshot: Snapshot | null, contextRunId: string, material: LearningMaterialResponse, intent: ContentIntent, unavailable=false): Capability {
  const run=learningRun(snapshot),deny=(reason:string)=>({allowed:false,reason});
  if(!run || run.runId!==contextRunId || unavailable || !run.planHash || run.revision==null) return deny('Сначала обновите состояние выбранного запуска.');
  const read = learningCapability(run, 'openLearning');
  if (!read.allowed) return read;
  const key=intent.action==='generate-lesson'?'generateLesson':intent.action==='ask-lesson'?'askLesson':'setLearningProgress';
  const capability=material.capabilities[key] ?? deny('Сервис не сообщил о доступности этого действия.');
  if(!capability.allowed)return capability;
  if(intent.action!=='set-progress' && run.learning.activeJob)return deny('В этом запуске уже выполняется учебный запрос.');
  if(intent.action==='ask-lesson' && (!hash(intent.lessonHash)||intent.lessonHash!==material.lessonHash||!sourceAnchor(intent.anchor)||!anchorInCatalog(intent.anchor,material.sources)||!intent.question.trim()||intent.question.length>4000))return deny('Выберите сохраненный фрагмент и задайте вопрос до 4000 символов.');
  return capability;
}
export function contentOperation(snapshot: Snapshot, material: LearningMaterialResponse, intent: ContentIntent, operationId:string): PendingLearningOperation {
  if(!snapshot.planHash||snapshot.revision==null)throw Error('Missing learning command binding');
  const envelope={operationId,expectedRevision:snapshot.revision,planHash:snapshot.planHash,materialHash:material.id};
  const base={kind:'learning' as const,key:`${snapshot.runId}:${intent.action}:${material.id}`,operationId,runId:snapshot.runId};
  if(intent.action==='ask-lesson')return {...base,action:intent.action,request:{...envelope,lessonHash:intent.lessonHash,anchor:{...intent.anchor},question:intent.question}};
  if(intent.action==='set-progress')return {...base,action:intent.action,request:{...envelope,progress:intent.progress}};
  return {...base,action:intent.action,request:envelope};
}
