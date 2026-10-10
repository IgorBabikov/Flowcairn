import { timingSafeEqual } from 'node:crypto';

// Keep the viewer server self-contained: it is also built/tested from a copied
// viewer directory and must not resolve the source runtime through cwd paths.
class GraphError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sanitizeText(value) {
  return String(value)
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[\w./-]+)\b/gi, '[redacted]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+/g, '[host-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // eslint-disable-line no-control-regex -- remove unsafe control characters
    .slice(0, 12000);
}

export function authorize(request, token, origin) {
  const actual = request.headers['x-flowcairn-control'];
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual),
    expectedBytes = Buffer.from(token);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    return false;
  return (
    (!request.headers.origin || request.headers.origin === origin) &&
    request.headers['sec-fetch-site'] !== 'cross-site'
  );
}

export async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new GraphError('CONTENT_TYPE', 'Требуется application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new GraphError('BODY_LIMIT', 'Запрос превышает 256 KiB');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GraphError('INVALID_JSON', 'Требуется корректный JSON');
  }
}

export function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function sendError(response, error) {
  const code = typeof error.code === 'string' ? error.code : 'INVALID_REQUEST';
  const status = ['NOT_FOUND', 'RUN_NOT_FOUND', 'STORE_NOT_FOUND'].includes(code)
    ? 404
    : ['REVISION_CONFLICT', 'CAS_CONFLICT', 'PLAN_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'STALE_CONTEXT', 'INTAKE_BUSY', 'HOLD_CONFLICT'].includes(code)
      ? 409
      : ['ORCHESTRATOR_TIMEOUT', 'GIT_TIMEOUT', 'SOURCE_CAPTURE_TIMEOUT'].includes(code)
        ? 504
      : code === 'BODY_LIMIT'
        ? 413
        : 400;
  send(response, status, {
    ok: false,
    error: {
      code,
      message:
        typeof error?.code === 'string'
          ? sanitizeText(error.message)
          : 'Некорректный запрос или недоступное действие',
    },
  });
}

function learningQuery(url, allowed = []) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new GraphError('INVALID_REQUEST', 'Неизвестные или повторяющиеся параметры учебного запроса');
  }
}

function sourcePageParameter(url, key, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
    throw new GraphError('INVALID_REQUEST', 'Нужен допустимый диапазон строк сохраненного источника');
  return value;
}

/** Reads are material-bound service operations, never live filesystem paths. */
export async function learningRead(service, response, url) {
  const material = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})(?:\/sources\/([a-z][a-z0-9-]{1,79}))?$/,
  );
  if (material) {
    const [, runId, materialHash, sourceId] = material;
    learningQuery(url, sourceId ? ['startLine', 'lineCount', 'startColumn'] : []);
    const result = sourceId
      ? await service.learningSource(runId, materialHash, sourceId, {
        startLine: sourcePageParameter(url, 'startLine', 1),
        lineCount: sourcePageParameter(url, 'lineCount', 100, 200),
        ...(url.searchParams.has('startColumn') ? { startColumn: sourcePageParameter(url, 'startColumn', 0) } : {}),
      })
      : await service.learningMaterial(runId, materialHash);
    send(response, 200, result);
    return true;
  }
  const chapterIndex = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})\/chapters$/,
  );
  if (chapterIndex) {
    learningQuery(url);
    const [, runId, materialHash] = chapterIndex;
    send(response, 200, await service.readLearningChapterBook(runId, materialHash));
    return true;
  }
  const chapter = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})\/chapters\/books\/([a-f0-9]{64})(?:\/chapters\/([a-f0-9]{64}))?$/,
  );
  if (chapter) {
    learningQuery(url);
    const [, runId, materialHash, bookHash, chapterHash] = chapter;
    const result = chapterHash
      ? await service.readLearningChapter(runId, materialHash, bookHash, chapterHash)
      : await service.readLearningChapterBook(runId, materialHash, bookHash);
    send(response, 200, result);
    return true;
  }
  const observation = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})\/observations\/([a-f0-9]{64})$/,
  );
  if (observation) {
    learningQuery(url);
    const [, runId, materialHash, observationHash] = observation;
    send(response, 200, await service.readLearningObservation(runId, materialHash, observationHash));
    return true;
  }
  const practice = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})\/practice\/([a-f0-9]{64})$/,
  );
  if (practice) {
    learningQuery(url);
    const [, runId, materialHash, logHash] = practice;
    send(response, 200, await service.readLearningPractice(runId, materialHash, logHash));
    return true;
  }
  const unavailable = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/(lessons\/([a-f0-9]{64})|answers\/([a-f0-9]{64})|jobs\/([a-z][a-z0-9-]{1,79}))$/,
  );
  if (!unavailable) return false;
  learningQuery(url);
  const [, runId, , lessonHash, answerHash, jobId] = unavailable;
  const kind = lessonHash ? 'lesson' : answerHash ? 'answer' : 'job';
  send(response, 200, await service.learningObject(runId, kind, lessonHash ?? answerHash ?? jobId));
  return true;
}

/** HTTP adapter only: all permission, state, gate and retry rules live in WorkflowService. */
export async function control(service, request, response, url) {
  const body = await readBody(request);
  if (url.pathname === '/api/intake/preview')
    return send(response, 200, await service.previewIntake(body));
  if (url.pathname === '/api/intake') {
    return send(response, 201, {
      ok: true,
      result: await service.intake(body, { actor: 'local-operator' }),
    });
  }
  if (url.pathname === '/api/runs') {
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).some((k) => !['spec', 'runId', 'operationId'].includes(k))
    )
      throw new GraphError('INVALID_REQUEST', 'Ожидаются spec, runId и operationId');
    return send(response, 201, {
      ok: true,
      result: await service.create(body.spec, {
        runId: body.runId,
        operationId: body.operationId,
        actor: 'local-operator',
      }),
    });
  }
  const practiceCommand = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/materials\/([a-f0-9]{64})\/practice(?:\/(feedback))?$/,
  );
  if (practiceCommand) {
    learningQuery(url);
    const [, runId, materialHash, feedback] = practiceCommand;
    if (!body || typeof body !== 'object' || body.materialHash !== materialHash)
      throw new GraphError('INVALID_REQUEST', 'Практика должна ссылаться на тот же материал.');
    const result = feedback
      ? await service.appendLearningPracticeFeedback(runId, body, 'local-operator')
      : await service.appendLearningPractice(runId, body, 'local-operator');
    return send(response, 200, { ok: true, result });
  }
  const learningCommand = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/learning\/commands\/(generate-lesson|ask-lesson|set-progress)$/,
  );
  if (learningCommand) {
    learningQuery(url);
    const [, runId, command] = learningCommand;
    return send(response, command === 'set-progress' ? 200 : 202, {
      ok: true,
      result: await service.command(runId, command === 'set-progress' ? 'set-learning-progress' : command, body, { actor: 'local-operator' }),
    });
  }
  const match = url.pathname.match(
    /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/control\/(run|retry|rerun-check|recover|gate|stop|replan|revise-plan|verify-requirement|continue-learning|set-learning-mode)$/,
  );
  if (!match)
    return send(response, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Операция не найдена' },
    });
  if (['continue-learning', 'set-learning-mode'].includes(match[2])) learningQuery(url);
  return send(response, 200, {
    ok: true,
    result: await service.command(match[1], match[2], body, { actor: 'local-operator' }),
  });
}
