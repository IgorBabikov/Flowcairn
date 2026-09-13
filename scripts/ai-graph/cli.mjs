#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkflowService, sanitizeText } from './lib/service.mjs';
import { GraphError } from './lib/io.mjs';
import { prepareCheckImage } from './lib/docker-checks.mjs';

const ALLOWED = new Set([
  'root',
  'spec',
  'run',
  'node',
  'plan-hash',
  'revision',
  'operation',
  'permissions',
  'decision',
  'draft',
  'reason',
  'hash',
  'after',
]);
export function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]?.slice(2),
      value = tokens[index + 1];
    if (
      !tokens[index]?.startsWith('--') ||
      !ALLOWED.has(key) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(parsed, key)
    )
      throw new GraphError('INVALID_ARGUMENT', 'Неизвестный, повторный или незаполненный флаг');
    parsed[key] = value;
  }
  return parsed;
}
function required(args, name) {
  if (!args[name]) throw new GraphError('MISSING_ARGUMENT', `Требуется --${name}`);
  return args[name];
}
function jsonFile(file) {
  const bytes = readFileSync(path.resolve(file));
  if (bytes.length > 256 * 1024) throw new GraphError('INPUT_LIMIT', 'JSON превышает 256 KiB');
  return JSON.parse(bytes.toString('utf8'));
}

export async function runCli(command, args, service) {
  if (command === 'help')
    return {
      usage: [
        'prepare-checks --root ROOT (explicit local dependency-image setup, never a run action)',
        'create --spec TASK.json [--run RUN_ID] [--operation OP_ID]',
        'status [--run RUN_ID]',
        'plan|events --run RUN_ID [--after REVISION]',
        'receipt|artifact --run RUN_ID --hash SHA256',
        'approve --run RUN_ID --plan-hash SHA256 --permissions ai.read,workspace.source.write,workspace.output.write',
        'accept|reject --run RUN_ID --plan-hash SHA256 [--reason TEXT]',
        'run|retry|rerun-check|recover|stop --run RUN_ID --plan-hash SHA256 [--node NODE_ID]',
        'replan --run RUN_ID --plan-hash SHA256 [--draft NODES.json]',
      ],
      note: 'TaskSpec.id связывает Graph с существующей задачей Orchestrator. Нет arbitrary shell, автоматического commit/push/deploy. JSON actions используют тот же service, что UI.',
    };
  if (command === 'prepare-checks') return prepareCheckImage({ root: service.root });
  if (command === 'create')
    return service.create(jsonFile(required(args, 'spec')), {
      runId: args.run,
      operationId: args.operation,
    });
  if (command === 'status')
    return args.run ? service.snapshot(args.run) : { runs: service.listRuns() };
  const runId = required(args, 'run');
  if (command === 'plan') return service.plan(runId);
  if (command === 'events') return { events: service.events(runId, Number(args.after ?? -1)) };
  if (command === 'receipt' || command === 'artifact')
    return service[command](runId, required(args, 'hash'));
  const snapshot = service.snapshot(runId);
  const request = {
    operationId: args.operation ?? `op-${randomUUID()}`,
    expectedRevision: args.revision ? Number(args.revision) : snapshot.revision,
    planHash: required(args, 'plan-hash'),
  };
  if (args.node) request.nodeId = args.node;
  if (args.reason) request.reason = args.reason;
  if (['approve', 'accept', 'reject'].includes(command)) {
    const gate = snapshot.gates.find((g) =>
      args.node
        ? g.nodeId === args.node
        : command === 'approve'
          ? g.type === 'approve-plan'
          : command === 'accept'
            ? g.type === 'accept-result'
            : true,
    );
    if (!gate) throw new GraphError('GATE_NOT_READY', 'Нет ожидающего gate');
    request.nodeId = gate.nodeId;
    request.decision = command;
    request.challenge = gate.challenge;
    if (command === 'approve')
      request.permissions = required(args, 'permissions').split(',').filter(Boolean);
    return service.command(runId, 'gate', request);
  }
  if (command === 'replan' && args.draft) request.draft = jsonFile(args.draft);
  return service.command(runId, command, request);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'help', ...tokens] = process.argv.slice(2);
  try {
    const args = parseArgs(tokens),
      service =
        command === 'help'
          ? null
          : await WorkflowService.open({ root: path.resolve(args.root ?? process.cwd()) });
    const result = await runCli(command, args, service);
    process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: error.code ?? 'INVALID_REQUEST', message: sanitizeText(error.message) } }, null, 2)}\n`,
    );
    process.exitCode = 2;
  }
}
