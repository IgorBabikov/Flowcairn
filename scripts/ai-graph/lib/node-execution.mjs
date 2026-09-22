import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphError, hashObject, now } from './io.mjs';
import { resolveAction, pathAllowed } from './registry.mjs';
import { AIResultSchema, AIPlanningResultSchema, AIAnalysisResultSchema, AIReviewResultSchema, ReceiptSchema, assertJsonBounds } from './schemas.mjs';
import { compileTaskProposal } from './planning.mjs';
import { reconcile } from './state.mjs';
import { verifySkillsUsed } from './skills.mjs';
import { buildReviewEvidence } from './review-evidence.mjs';
import { boundPriorEvidence } from './bounded-context.mjs';
import { selectAnalysisEvidence } from './analysis-evidence.mjs';
import { normalizeRequirementReview, validateRequirementAssessments } from './requirement-verification.mjs';
import { projectContextMap } from './project-context-map.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const unique = (values) => [...new Set(values)];
const externalProvider = (provider) => ['claude', 'cursor'].includes(provider);

// Executes one registered action. The service supplies fenced state/permission operations.
export async function executeNode(host, state, task, plan, definition, signal) {
    const action = resolveAction(
      definition.action.id,
      definition.action.version,
      definition.action.inputs,
    );
    if (
      !definition.needs.every((id) => state.nodes[id].status === 'passed') ||
      !definition.permissions.every((p) => state.permissions.includes(p))
    )
      fail('EXECUTION_DENIED', 'Dependencies или permissions не выполнены');
    const before = await host.assertWorkspace(state),
      attempt = state.nodes[definition.id].attempts + 1,
      attemptId = `attempt-${randomUUID()}`,
      startedAt = now();
    const beforeContents = host.adapters.captureBefore?.(
      state.binding.worktree,
      before,
      definition,
    );
    if (attempt > definition.retry.maxAttempts) fail('ATTEMPT_LIMIT', 'Лимит попыток исчерпан');
    const startReceipt = host.receipt(state, task, plan, definition, {
      phase: 'started',
      attempt,
      attemptId,
      startedAt,
      finishedAt: null,
      durationMs: null,
      verdict: 'started',
      afterFingerprint: null,
      ...(definition.action.id.startsWith('ai-') && externalProvider(host.adapters.project?.ai.provider)
        ? { providerConsentHash: host.providerConsent(state, task, plan).hash }
        : {}),
    });
    const nodes = structuredClone(state.nodes);
    Object.assign(nodes[definition.id], {
      status: 'running',
      attempts: attempt,
      receipts: [...nodes[definition.id].receipts, startReceipt],
      startedAt,
      finishedAt: null,
      reason: null,
      retrySafe: false,
    });
    state = host.write(state, {
      nodes,
      status: 'running',
      activeOperation: { ...state.activeOperation, nodeId: definition.id, process: null },
    });
    const artifacts = [],
      checks = [];
    let changedFiles = [],
      result,
      aiOutput,
      reviewBundle,
      executionInvoked = false,
      processStarted = false,
      fencedAfter,
      after = null,
      verdict,
      reason = null;
    const started = performance.now();
    try {
      if (definition.action.id === 'workspace-check') {
        const assessment = host.adapters.inspectChanges(
          host.initialFingerprint(state.initialFingerprint),
          before,
          {
            ...definition,
            permissions: ['workspace.source.write'],
            resources: { ...definition.resources, writes: task.scope },
          },
          task,
        );
        result = { exitCode: assessment.allowed ? 0 : 1, stopped: true, uncertain: false };
        artifacts.push(host.putArtifact('test-report', 'Проверка границ workspace', assessment));
        if (!assessment.allowed) reason = 'Изменения выходят за утвержденный scope';
      } else if (definition.action.id === 'artifact-handoff') {
        const evidence = plan.nodes
          .filter((n) => n.id !== definition.id)
          .flatMap((n) => state.nodes[n.id].receipts);
        artifacts.push(
          host.putArtifact('handoff', 'Результат для приемки', {
            goal: task.goal,
            acceptance: task.acceptance,
            planHash: state.planHash,
            receipts: evidence,
            previousExecutions: host.executionHistory(state).map((source) => ({ runId: source.state.runId, planHash: source.state.planHash, receipts: Object.values(source.state.nodes).flatMap((node) => node.receipts) })),
            changedFiles: unique([state, ...host.executionHistory(state).map((source) => source.state)].flatMap((item) => Object.values(item.nodes).flatMap((n) => n.changedFiles))),
            integration: plan.workflow === 'autonomous' ? 'Готово к личному ревью. Commit и PR пользователь выполняет самостоятельно.' :
              'Требуется отдельная проверка и интеграция Orchestrator; commit/push/deploy не выполнялись',
          }),
        );
        result = { exitCode: 0, stopped: true, uncertain: false };
      } else {
        const outputDirectory = host.privateDirectory(
          path.join(host.root, '.ai-orchestrator', 'graph'),
          `output-${attemptId}`,
        );
        if (definition.action.id.startsWith('ai-'))
          host.privateDirectory(path.join(host.root, '.ai-orchestrator', 'graph'), 'runner-tickets');
        const permittedFiles = before.files.filter((file) => pathAllowed(file.path, task));
        const fixFindings = state.planningArtifacts.flatMap((id) => {
          const artifact = host.artifact(id);
          if (artifact.mediaType !== 'application/json') return [];
          const data = JSON.parse(artifact.content);
          return data.reviewFindings ?? [];
        });
        if (Buffer.byteLength(JSON.stringify(fixFindings)) > 24 * 1024)
          fail('FIX_EVIDENCE_LIMIT', 'Полные review findings превышают bounded context; требуется более узкая задача');
        const analysisEvidence = selectAnalysisEvidence({ state, plan, readArtifact: host.artifact,
          readReceipt: (id) => host.store.readObject('receipts', id) });
        let priorEvidence = {
          ...(task.contextDiscovery && plan.stage === 'planning' ? { contextInventory: projectContextMap(before.files, task, host.adapters.project?.outputPaths ?? [], state.contextDiscoveryRound ?? 0) } : {}),
          ...(analysisEvidence ? { analysis: analysisEvidence } : {}),
          feedback: task.planningFeedback ?? [],
          reviewFindings: fixFindings,
          instructionMetadata: host.adapters.instructionMetadata?.(definition, task) ?? [],
          receipts: unique(Object.values(state.nodes).flatMap((n) => n.receipts)).slice(-64),
          workspaceFiles: permittedFiles.slice(0, 100),
          workspaceFilesTruncated: permittedFiles.length > 100,
          artifacts: unique([
            ...state.planningArtifacts,
            ...Object.values(state.nodes).flatMap((n) => n.artifacts),
          ])
            .map((hash) => {
              const artifact = host.artifact(hash);
              return {
                id: hash,
                kind: artifact.kind,
                title: artifact.title,
                excerpt: artifact.content.slice(0, 1500),
                truncated: artifact.content.length > 1500,
              };
            })
            .slice(-12),
        };
        while (Buffer.byteLength(JSON.stringify(priorEvidence)) > 30 * 1024) {
          if (priorEvidence.artifacts.length) priorEvidence.artifacts.shift();
          else if (priorEvidence.workspaceFiles.length) {
            priorEvidence.workspaceFiles.pop();
            priorEvidence.workspaceFilesTruncated = true;
          } else fail('CONTEXT_LIMIT', 'Структурированный анализ превышает допустимый размер');
        }
        if (plan.workflow === 'autonomous' && definition.action.id === 'ai-plan' && !priorEvidence.analysis && plan.taskContract?.rigor.level !== 'light')
          fail('ANALYSIS_REQUIRED', 'План требует сохраненного результата анализа');
        priorEvidence = boundPriorEvidence({ task, plan, node: definition, state, priorEvidence,
          readReceipt: (hash) => ReceiptSchema.parse(host.store.readObject('receipts', hash)) });
        if (definition.action.id === 'ai-review') {
          reviewBundle = buildReviewEvidence({
            state,
            task,
            plan,
            node: definition,
            fingerprint: before,
            previousExecutions: host.reviewHistory(state),
            readReceipt: (hash) => ReceiptSchema.parse(host.store.readObject('receipts', hash)),
            readArtifact: (hash) => host.artifact(hash),
          });
        }
        executionInvoked = true;
        result = await host.adapters.execute({
          root: host.root,
          worktree: state.binding.worktree,
          toolchain: state.toolchain,
          beforeFingerprint: before,
          node: definition,
          task,
          plan,
          skills: host.adapters.loadSkills(definition.skills),
          outputDirectory,
          signal,
          priorEvidence,
          reviewEvidence: reviewBundle?.evidence ?? null,
          ...(definition.action.id.startsWith('ai-') && externalProvider(host.adapters.project?.ai.provider)
            ? { providerConsent: host.providerConsent(state, task, plan) }
            : {}),
          onStart: (metadata) => {
            processStarted = true;
            const current = host.store.readRun(state.runId);
            host.adapters.verifyBinding(current.binding);
            if (current.activeOperation?.id !== state.activeOperation.id || current.stopRequested)
              fail('EXECUTION_FENCED', 'Операция больше не владеет run');
            const nodes = structuredClone(current.nodes);
            nodes[definition.id].process = metadata;
            host.write(current, {
              nodes,
              activeOperation: { ...current.activeOperation, process: metadata },
            });
          },
        });
      }
      if (
        definition.action.id.startsWith('ai-') &&
        result.exitCode === 0 &&
        result.stopped &&
        !result.uncertain
      ) {
        assertJsonBounds(result.output);
        aiOutput = (definition.action.id === 'ai-plan' ? AIPlanningResultSchema : definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous' ? AIAnalysisResultSchema : reviewBundle ? AIReviewResultSchema : AIResultSchema).parse(result.output);
        if (definition.action.id === 'ai-plan' && aiOutput.verdict === 'pass' && !Reflect.get(aiOutput, 'contextRequests')?.length)
          compileTaskProposal(task, aiOutput, { runtimeHash: host.adapters.identity(), skills: host.adapters.skills(task), resolveSkills: host.adapters.resolveSkills, resolveReadPaths: host.adapters.resolveReadPaths, contextHash: host.adapters.contextHash?.(task), provider: host.adapters.project?.ai.provider, analysis: host.analysis(state, plan), workflow: plan.workflow });
        if (reviewBundle) {
          const verified = buildReviewEvidence({
            state,
            task,
            plan,
            node: definition,
            fingerprint: before,
            previousExecutions: host.reviewHistory(state),
            readReceipt: (hash) => ReceiptSchema.parse(host.store.readObject('receipts', hash)),
            readArtifact: (hash) => host.artifact(hash),
          });
          if (verified.hash !== reviewBundle.hash || aiOutput.reviewEvidenceHash !== verified.hash)
            fail('REVIEW_EVIDENCE_MISMATCH', 'Review result не связан с полным evidence');
          validateRequirementAssessments({ output: aiOutput, plan, node: definition, worktree: state.binding.worktree, fingerprint: before });
        }
        if (definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous') {
          if (Buffer.byteLength(JSON.stringify(aiOutput)) > 20 * 1024) fail('ANALYSIS_LIMIT', 'Анализ превышает ограниченный контекст передачи');
          if (AIAnalysisResultSchema.parse(aiOutput).analysis.projectFacts.some((fact) => !definition.resources.reads.some((scope) => fact.path === scope.replace(/\/$/, '') || fact.path.startsWith(scope.replace(/\/$/, '') + '/'))))
            fail('ANALYSIS_SCOPE', 'Факты анализа выходят за объявленный контекст');
        }
        verifySkillsUsed(host.adapters.loadSkills(definition.skills), aiOutput.skillsUsed);
        if (
          aiOutput.changedFiles.some((file) => !pathAllowed(file, task)) ||
          aiOutput.plan.some((step) => step.paths.some((file) => !pathAllowed(file, task)))
        )
          fail('AI_SCOPE', 'AI-result предлагает расширение scope');
        const unchanged = host.adapters.fingerprint(state.binding.worktree, state.toolchain);
        if (unchanged.hash !== before.hash)
          fail('AI_WRITE_VIOLATION', 'AI subprocess изменил source в read-only режиме');
        if (action.kind === 'implementation') {
          const declaredChanges = unique([
            ...aiOutput.edits.map((edit) => edit.path),
            ...aiOutput.moves.flatMap((move) => [move.from, move.to]),
            ...aiOutput.jsonTransfers.flatMap((transfer) => [transfer.from, transfer.to]),
          ]);
          if (
            hashObject(declaredChanges.sort()) !==
            hashObject([...aiOutput.changedFiles].sort())
          )
            fail('PATCH_FILES_MISMATCH', 'edits и changedFiles не совпадают');
          if (
            aiOutput.verdict === 'pass' &&
            !aiOutput.findings.some((f) => f.severity === 'blocking')
          ) {
            if (!host.adapters.applyEdits)
              fail('PATCH_HANDLER_MISSING', 'Trusted patch handler недоступен');
            fencedAfter = host.applyFencedEdits(
              state,
              task,
              plan,
              definition,
              before,
              aiOutput.edits,
              aiOutput.moves,
              aiOutput.jsonTransfers,
            );
          }
        } else if (aiOutput.edits.length || aiOutput.moves.length || aiOutput.jsonTransfers.length || aiOutput.changedFiles.length)
          fail('AI_WRITE_VIOLATION', 'Read action не может предлагать запись');
      }
      after = fencedAfter ?? host.adapters.fingerprint(state.binding.worktree, state.toolchain);
      const assessment = host.adapters.inspectChanges(before, after, definition, task);
      changedFiles = assessment.changedFiles;
      host.read(state.runId);
      if (!result.stopped || result.uncertain) {
        verdict = 'uncertain';
        reason =
          reason ??
          (result.failureReason === 'TIMEOUT'
              ? 'TIMEOUT: Истек лимит времени выполнения этапа; остановка процесса не подтверждена'
              : 'Остановка процесса или результат не подтверждены');
      } else if (!assessment.allowed) {
        verdict = 'fail';
        reason = reason ?? 'Нарушена граница изменений';
      } else if (result.exitCode !== 0) {
        verdict = 'fail';
        reason = reason ?? host.sanitizeText(result.failureReason ?? 'Действие завершилось с ошибкой');
      } else if (definition.action.id.startsWith('ai-')) {
        assertJsonBounds(result.output);
        const candidateOutput = aiOutput ?? AIResultSchema.parse(result.output);
        const output = definition.action.id === 'ai-review' ? normalizeRequirementReview(candidateOutput, plan.taskContract) : candidateOutput;
        verifySkillsUsed(host.adapters.loadSkills(definition.skills), output.skillsUsed);
        // Analysis is evidence for the planner, not an implementation claim. A
        // warnings-only analysis has already identified a bounded local path, so
        // do not let an overly cautious model turn it into a terminal state.
        const continuableAnalysis =
          definition.action.id === 'ai-analyze' &&
          plan.workflow === 'autonomous' &&
          output.verdict === 'uncertain' &&
          !output.contextRequests?.length &&
          !output.findings.some((finding) => finding.severity === 'blocking');
        const safe = {
          ...output,
          ...(continuableAnalysis ? { verdict: 'pass' } : {}),
          ...(output.contextRequests?.length ? { verdict: 'uncertain' } : {}),
          ...(output.contextRequests ? { contextRequests: output.contextRequests.map((item) => ({ ...item, reason: host.sanitizeText(item.reason) })) } : {}),
          summary: host.sanitizeText(output.summary),
          findings: output.findings.map((f) => ({ ...f, message: host.sanitizeText(f.message) })),
          plan: output.plan.map((p) => ({ ...p, outcome: host.sanitizeText(p.outcome) })),
          ...(definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous' ? { analysis: Object.fromEntries(Object.entries(AIAnalysisResultSchema.parse(output).analysis).map(([key, values]) => [key, key === 'projectFacts' ? values.map((value) => ({ path: value.path, fact: host.sanitizeText(value.fact) })) : values.map(host.sanitizeText)])) } : {}),
          ...(definition.action.id === 'ai-plan' ? { steps: AIPlanningResultSchema.parse(output).steps.map((step) => ({ ...step, title: host.sanitizeText(step.title), outcome: host.sanitizeText(step.outcome) })) } : {}),
        };
        verdict =
          safe.verdict === 'pass' && !output.findings.some((f) => f.severity === 'blocking')
            ? 'pass'
            : safe.verdict === 'uncertain'
              ? 'uncertain'
              : 'fail';
        if (verdict !== 'pass') {
          reason = host.sanitizeText(output.findings.find((finding) => finding.severity === 'blocking')?.message || output.summary || 'AI не подтвердил результат');
          if (action.kind === 'implementation')
            artifacts.push(host.putArtifact('review-findings', 'Почему реализация остановлена', {
              summary: safe.summary, verdict, findings: safe.findings,
            }));
        }
        if (action.kind === 'analysis')
          artifacts.push(host.putArtifact('analysis', 'Анализ задачи', safe));
        if (action.kind === 'review')
          artifacts.push(host.putArtifact('review-findings', 'Независимое review', safe));
        if (action.kind === 'implementation') {
          if (
            verdict === 'pass' &&
            hashObject([...output.changedFiles].sort()) !== hashObject([...changedFiles].sort())
          ) {
            verdict = 'uncertain';
            reason = 'Заявленные AI changedFiles не совпадают с fingerprint';
          }
          const diff = host.adapters.diff(state.binding.worktree, before, after, beforeContents);
          artifacts.push(
            host.putArtifact('diff', 'Изменения workspace', diff.content, diff.mediaType ?? 'text/x-diff'),
            host.putArtifact('changed-files', 'Измененные файлы', {
              changedFiles,
              before: before.hash,
              after: after.hash,
              complete: diff.complete,
              ...(diff.format ? { format: diff.format } : {}),
            }),
          );
          if (!diff.complete) {
            verdict = 'uncertain';
            reason = 'Diff evidence неполное';
          }
        }
      } else {
        verdict = 'pass';
        if (definition.action.id.startsWith('check-')) {
          const check = {
            id: definition.id,
            passed: true,
            exitCode: 0,
            durationMs: performance.now() - started,
            summary: 'Зарегистрированная проверка завершилась успешно',
            inputHash: before.hash,
          };
          checks.push(check);
          artifacts.push(host.putArtifact(action.artifacts[0], definition.title, check));
        }
      }
      if (definition.action.id.startsWith('check-') && result.exitCode !== 0) {
        const check = {
          id: definition.id,
          passed: false,
          exitCode: result.exitCode,
          durationMs: performance.now() - started,
          summary: reason ?? 'Проверка не пройдена',
          inputHash: before.hash,
        };
        checks.push(check);
        artifacts.push(host.putArtifact(action.artifacts[0], definition.title, check));
      }
      if (
        verdict === 'pass' &&
        !action.artifacts.every((kind) =>
          artifacts.some((hash) => host.artifact(hash).kind === kind),
        )
      ) {
        verdict = 'fail';
        reason = 'Не выполнен artifact success contract';
      }
    } catch (error) {
      reason = host.safeReason(error);
      verdict = 'uncertain';
      if (!processStarted && !result && error instanceof GraphError &&
          ['RUNNER_PROMPT_LIMIT', 'AI_CONTEXT_LIMIT', 'INSTRUCTION_CONTEXT_LIMIT'].includes(error.code)) {
        // These errors are raised during command preparation, before a process is started.
        result = { exitCode: 1, stopped: true, uncertain: false,
          execution: { kind: 'preflight', processStarted: false, reason: error.code } };
      }
      // A rejected read-only proposal is a known failure only when no workspace effect occurred.
      const rejectedReviewPreflight =
        definition.action.id === 'ai-review' &&
        !executionInvoked &&
        error instanceof GraphError &&
        error.code.startsWith('REVIEW_EVIDENCE_');
      if (rejectedReviewPreflight || (result?.stopped === true && result?.uncertain !== true)) {
        try {
          after = host.adapters.fingerprint(state.binding.worktree, state.toolchain);
          changedFiles = host.adapters.inspectChanges(before, after, definition, task).changedFiles;
          if (after.hash === before.hash) verdict = 'fail';
        } catch {
          // Missing or unreliable workspace evidence remains uncertain.
        }
      }
    }
    const current = host.store.readRun(state.runId),
      finishedAt = now(),
      durationMs = performance.now() - started;
    host.assertExecutionOwner(current, state, definition, { allowStop: true });
    if (current.stopRequested && result?.failureReason === 'ABORTED' &&
        result.stopped === true && result.uncertain !== true && after) {
      verdict = 'cancelled';
      reason = 'CANCELLED_BY_USER';
    }
    const receipt = host.receipt(current, task, plan, definition, {
      attempt,
      attemptId,
      startedAt,
      finishedAt,
      durationMs,
      verdict,
      exitCode: result?.exitCode ?? null,
      checks,
      artifacts,
      changedFiles,
      failureReason: reason,
      beforeFingerprint: before.hash,
      afterFingerprint: after?.hash ?? null,
      ...(reviewBundle ? { reviewEvidenceHash: reviewBundle.hash } : {}),
      termination: result
        ? {
            stopped: result.stopped === true,
            uncertain: result.uncertain === true,
            timedOut: result.timedOut === true,
            outputLimit: result.outputLimit === true,
            signal: result.signal ?? null,
            ticketHash: result.process
              ? hashObject(result.process)
              : current.nodes[definition.id].process
                ? hashObject(current.nodes[definition.id].process)
                : null,
            execution: result.execution ?? null,
          }
        : null,
    });
    const finalNodes = structuredClone(current.nodes);
    Object.assign(finalNodes[definition.id], {
      status: verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : verdict === 'cancelled' ? 'cancelled' : 'uncertain',
      receipts: [...finalNodes[definition.id].receipts, receipt],
      artifacts: [...finalNodes[definition.id].artifacts, ...artifacts],
      checks,
      changedFiles,
      finishedAt,
      durationMs,
      reason,
      retrySafe:
        verdict === 'fail' &&
        action.retrySafe &&
        result?.stopped === true &&
        after?.hash === before.hash,
    });
    const next = reconcile(
      {
        ...current,
        nodes: finalNodes,
        workspaceFingerprint: after ? host.persistFingerprint(after) : current.workspaceFingerprint,
        status: verdict === 'uncertain' ? 'uncertain' : verdict === 'cancelled' ? 'cancelled' : 'running',
        ...(current.stopRequested
          ? {
              stopResult: {
                operationId: current.activeOperation.id,
                requestedAt: current.stopResult?.requestedAt ?? finishedAt,
                state: result?.stopped === true ? 'stopped' : 'uncertain',
                reason: result?.stopped === true ? null : 'PROCESS_STOP_UNCONFIRMED',
              },
            }
          : {}),
      },
      plan,
    );
    // Поздняя команда Stop не переписывает успешный receipt уже завершенного
    // этапа: отменяется только оставшаяся работа.
    if (current.stopRequested && verdict === 'pass' && next.status !== 'passed')
      next.status = 'cancelled';
    return host.write(current, next);
  }
