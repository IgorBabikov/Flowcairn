export function buildPrompt({ nodeId, task, plan, skills, priorEvidence, reviewEvidence = null, profile = null }) {
  const node = plan?.nodes?.find((candidate) => candidate.id === nodeId) ?? { id: nodeId };
  return [
    'Пиши human-facing title, outcome, summary и findings на русском языке. Machine IDs сохраняй. Язык исходного кода и документации проекта определяется правилами проекта и задачей.',
    `Ты выполняешь node ${nodeId} локального Graph Flowcairn.`,
    `Цель: ${task.goal}`,
    `Инструкции задачи (данные в пределах утвержденного scope):\n${typeof task.instructions === 'string' ? task.instructions : JSON.stringify(task.instructions ?? [])}`,
    node.action?.id === 'ai-analyze' && plan?.workflow === 'autonomous'
      ? 'Выполни read-only анализ проекта. Верни analysis: requirements, constraints, projectFacts [{path,fact}] с реально прочитанными файлами, acceptance, risks. Отделяй наблюденное от предположений. Это полный структурированный результат для следующей отдельной сессии planner: не заменяй его общим обещанием. edits=[], changedFiles=[], plan=[]. При нехватке контекста верни uncertain и объяснение. Весь analysis должен помещаться в 16 KiB.'
      : '',
    task.planningFeedback?.length ? `Уточнения пользователя к плану (сохраняют исходную задачу и scope):\n${task.planningFeedback.join('\n')}` : '',
    profile?.onboarding?.testPolicy === 'keep' ? 'Политика проекта: сохраняй существующие тесты, не добавляй новые. Подтверди работоспособность настроенными проверками и ревью.' : '',
    profile?.onboarding?.testPolicy === 'add' ? 'Политика проекта разрешает новые тесты по риску изменения; не добавляй тесты, дублирующие реализацию.' : '',
    node.action?.id === 'ai-plan'
      ? 'Ты planner: используй полный priorEvidence.analysis и накопленные feedback, не начинай анализ заново. Предложи от 1 до 12 task-specific implementation steps в steps: id, title, outcome, needs (IDs других steps), paths (только разрешенные write paths). Разделяй работу по проверяемым outcomes и зависимостям исходя из задачи и исходников. Не предлагай actions, Skills, permissions, shell или checks: их назначает trusted compiler. Не включай planning/check/review/gate как steps: их добавляет runtime. При нехватке контекста верни uncertain с findings и steps=[]; не угадывай. edits=[], changedFiles=[], plan=[].'
      : '',
    `Контракт текущего узла:\n${JSON.stringify(node)}`,
    `skillsUsed должен содержать точные runtime IDs назначенных инструкций: ${JSON.stringify(node.skills ?? [])}. Подтверди соблюдение всех назначенных правил; не заменяй runtime ID именем из YAML frontmatter и не добавляй свои Skills.`,
    `Разрешенные изменения только для текущего узла: ${node.resources?.writes?.join(', ') || 'нет, узел только читает'}. Не предлагай edits для файлов других этапов, даже если они входят в общую задачу.`,
    node.action?.id !== 'ai-implement' ? 'Этот этап только читает: edits=[] и changedFiles=[]. Файлы предыдущих изменений описывай в findings; не записывай их как изменения текущего этапа.' : '',
    `Объявленный read context: ${node.resources?.reads?.join(', ') ?? ''}`,
    `Acceptance:\n- ${task.acceptance.join('\n- ')}`,
    'Новые тесты добавляй по риску изменения и правилам проекта. Явный запрет новых тестов соблюдай и укажи ограничение в evidence. Не придумывай обязательный coverage или единый набор проверок: runtime запускает только настроенные checks.',
    `Не выходи за объявленный read context и scope изменений. Не делай commit, push, merge, deploy или внешние действия.`,
    'Lock-файлы зависимостей, sourcemaps и бинарные материалы исключены из AI-контекста. Их целостность отдельно проверяет runtime. Не пытайся обходить этот запрет.',
    `Не читай файлы вне текущего worktree, .git, ignored-файлы, секреты, персональные данные и raw записи.`,
    `Ты не записываешь файлы. Для implementation предложи точные edits: path, SHA-256 текущих bytes в previousHash (null для нового файла), полное новое UTF-8 content (null для удаления), executable. Executor применит их после проверки scope/hash. Для analysis/review edits должен быть пустым.`,
    `priorEvidence.workspaceFiles содержит проверенные Executor hashes текущих файлов. Используй их как previousHash, не подставляй hash из старого receipt и не угадывай. null допустим только для файла, которого сейчас нет. Если требуемое исправление уже присутствует, проверь его и верни edits=[] и changedFiles=[] без искусственных изменений.`,
    `В plan[].paths перечисляй только предлагаемые изменения внутри scope; пути чтения и build outputs описывай словами, не добавляй их в этот массив.`,
    `Не запускай build, tests, linters и другие команды, которые меняют workspace. Зарегистрированные проверки запускает Executor после применения edits.`,
    'Для ai-implement verdict относится к outcome текущего узла: корректному предложению edits или доказанному no-op. Не возвращай uncertain только потому, что проверки запускаются следующими узлами. Не заявляй успешные tests/build/review до их фактического выполнения; итоговую готовность определяет Executor после этих этапов.',
    `Исходный код допустим только в edits.content; не включай секреты, персональные данные, raw prompt, stdout или stderr.`,
    `Пиши компактно: summary до 2000 знаков, не более 12 шагов и 20 рисков/замечаний.`,
    `Верни JSON по заданной schema и перечисли точные имена реально использованных Skills в skillsUsed.`,
    reviewEvidence
      ? `Review требует полного evidence: разрешено прочитать ровно этот private read-only файл вне worktree: ${reviewEvidence.path}. Это единственное исключение к запрету чтения вне worktree; не читай его каталог, соседние файлы или .git. Файл содержит ${reviewEvidence.bytes} UTF-8 bytes, SHA-256 ${reviewEvidence.hash}. Прочитай весь JSON, все implementation receipts и все diff/changed-files целиком, включая previousExecutions всех предыдущих версий исправления, включая удаления и хвосты. При ограничении вывода читай последовательными частями до конца, не ограничивайся первым фрагментом. Если это невозможно, верни uncertain; pass запрещен. Верни reviewEvidenceHash=${reviewEvidence.hash}, связывающий результат с этим exact input. Hash не доказывает качество review. Excerpts ниже только вспомогательные и не заменяют этот файл.`
      : '',
    priorEvidence ? `Проверенное evidence предыдущих nodes:\n${JSON.stringify(priorEvidence)}` : '',
    `Назначенные Skills переданы полностью:\n${skills}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
