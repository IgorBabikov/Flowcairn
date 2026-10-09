import { timingSafeEqual } from 'node:crypto';
import { GraphError } from '../../scripts/ai-graph/lib/io.mjs';
import { sanitizeText } from '../../scripts/ai-graph/lib/service.mjs';

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
        error instanceof GraphError
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
