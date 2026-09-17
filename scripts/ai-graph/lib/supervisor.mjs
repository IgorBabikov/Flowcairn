import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUsageCollector } from './usage.mjs';
import { MAX_CONTROL_BYTES, MAX_CONTROL_INPUT_BYTES, validCommand } from './supervisor-control.mjs';

const MAX_TICKET_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 2_000;

// Only fixed error codes leave memory; provider output may contain secrets or source text.
export function classifyAiFailure(output) {
  const messages = output
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'error') return [String(event.message ?? '')];
        if (event.type === 'turn.failed') return [String(event.error?.message ?? '')];
      } catch {
        /* Not a Codex error event. */
      }
      return [];
    })
    .join('\n');
  const safeCodes = new Set([
    'AI_AUTH_REQUIRED',
    'AI_RATE_LIMIT',
    'AI_NETWORK_ERROR',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_REQUEST_REJECTED',
    'AI_RESPONSE_INCOMPLETE',
    'AI_RESPONSE_REFUSED',
    'AI_RESPONSE_INVALID',
    'AI_OUTPUT_LIMIT',
    'AI_CONTEXT_LIMIT',
    'AI_REVIEW_EVIDENCE_INVALID',
    'AI_WORKER_FAILED',
  ]);
  if (safeCodes.has(messages.trim())) return messages.trim();
  /** @type {Array<[RegExp, string]>} */
  const rules = [
    [/unauthori[sz]ed|invalid_api_key|authentication|\b401\b/i, 'AI_AUTH_REQUIRED'],
    [/rate.?limit|usage.?limit|too many requests|\b429\b/i, 'AI_RATE_LIMIT'],
    [
      /stream disconnected|error sending request|failed to connect|connection reset|network|dns/i,
      'AI_NETWORK_ERROR',
    ],
    [/service unavailable|overloaded|\b50[0234]\b/i, 'AI_PROVIDER_UNAVAILABLE'],
    [/invalid schema|invalid.*response_format|invalid.*output.schema/i, 'AI_INVALID_SCHEMA'],
    [/model.*(?:not found|does not exist|not supported|unavailable)/i, 'AI_MODEL_UNAVAILABLE'],
  ];
  for (const [pattern, code] of rules) {
    if (pattern.test(messages)) return code;
  }
  return 'NON_ZERO_EXIT';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error) {
  const code = /** @type {{code?: unknown}} */ (error).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function readTicket(ticketPath) {
  const stat = lstatSync(ticketPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe supervisor ticket');
  }
  if (stat.size < 2 || stat.size > MAX_TICKET_BYTES) throw new Error('Invalid ticket size');
  return JSON.parse(readFileSync(ticketPath, 'utf8'));
}

function writeTicket(ticketPath, value) {
  const temporary = `${ticketPath}.${process.pid}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, `${JSON.stringify(value)}\n`);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, ticketPath);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function sendControl(value) {
  writeSync(3, `${JSON.stringify(value)}\n`);
}

export async function supervise(ticketPath) {
  const initial = readTicket(ticketPath);
  if (
    initial.version !== 1 ||
    initial.state !== 'reserved' ||
    !/^[a-f0-9]{64}$/.test(initial.nonceHash) ||
    !/^[a-f0-9]{64}$/.test(initial.commandHash) ||
    !Number.isInteger(initial.timeoutMs) ||
    initial.timeoutMs < 1_000 ||
    initial.timeoutMs > 1_800_000 ||
    !Number.isInteger(initial.maxOutputBytes) ||
    initial.maxOutputBytes < 1_024 ||
    initial.maxOutputBytes > 30 * 1024 * 1024
  ) {
    throw new Error('Invalid supervisor ticket');
  }

  const startedAt = new Date().toISOString();
  sendControl({
    type: 'ready',
    pid: process.pid,
    pgid: process.pid,
    startedAt,
    nonceHash: initial.nonceHash,
    commandHash: initial.commandHash,
  });

  let action = null;
  let terminal = false;
  let terminatingReason = null;
  let control = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let diagnostic = Buffer.alloc(0);
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  const usageCollector = createUsageCollector();

  const finish = (exitCode, signal, failureReason = null) => {
    if (terminal) return;
    terminal = true;
    const final = {
      ...readTicket(ticketPath),
      state: 'finished',
      finishedAt: new Date().toISOString(),
      exitCode,
      signal,
      failureReason,
      stdoutBytes,
      stderrBytes,
      stdoutDigest: stdoutHash.digest('hex'),
      stderrDigest: stderrHash.digest('hex'),
      usage: initial.actionId?.startsWith('ai-') ? usageCollector.finish() : null,
    };
    writeTicket(ticketPath, final);
    sendControl({ type: 'finished', ...final });
    // A completed action must not keep its supervisor alive waiting for the parent's pipe.
    process.stdin.destroy();
    process.exitCode = 0;
  };

  const terminate = (reason) => {
    if (terminal || terminatingReason) return;
    terminatingReason = reason;
    writeTicket(ticketPath, {
      ...readTicket(ticketPath),
      state: 'terminating',
      failureReason: reason,
      terminatingAt: new Date().toISOString(),
    });
    if (!action) {
      finish(null, null, reason);
      return;
    }
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      try {
        action.kill('SIGTERM');
      } catch {
        // The parent will verify the process group independently.
      }
    }
    setTimeout(() => {
      if (terminal) return;
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exitCode = 1;
      }
    }, TERMINATION_GRACE_MS).unref();
  };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => terminate(`SUPERVISOR_${signal}`));
  }

  process.stdin.on('data', (chunk) => {
    if (action || terminal) return;
    control = Buffer.concat([control, chunk]);
    if (control.length > MAX_CONTROL_BYTES) {
      terminate('CONTROL_LIMIT');
      return;
    }
    const newline = control.indexOf(10);
    if (newline < 0) return;
    let message;
    try {
      message = JSON.parse(control.subarray(0, newline).toString('utf8'));
    } catch {
      terminate('CONTROL_INVALID');
      return;
    }
    control = Buffer.alloc(0);
    if (
      message?.type !== 'go' ||
      typeof message.nonce !== 'string' ||
      sha256(message.nonce) !== initial.nonceHash ||
      !validCommand(message.command) ||
      sha256(canonicalJson(message.command)) !== initial.commandHash ||
      typeof message.input !== 'string' ||
      Buffer.byteLength(message.input) > MAX_CONTROL_INPUT_BYTES
    ) {
      terminate('CONTROL_REJECTED');
      return;
    }

    writeTicket(ticketPath, {
      ...readTicket(ticketPath),
      state: 'running',
      actionStartedAt: new Date().toISOString(),
    });
    action = spawn(message.command.executable, message.command.args, {
      cwd: message.command.cwd,
      env: message.command.env,
      detached: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    action.once('error', (error) => finish(null, null, `SPAWN_ERROR:${errorCode(error)}`));
    const collect = (stream, digest, isStdout) => {
      stream.on('data', (data) => {
        digest.update(data);
        if (isStdout && initial.actionId?.startsWith('ai-')) {
          diagnostic = Buffer.concat([diagnostic, data]).subarray(-65536);
          usageCollector.push(data);
        }
        if (isStdout) stdoutBytes += data.length;
        else stderrBytes += data.length;
        const total = stdoutBytes + stderrBytes;
        if (total <= initial.maxOutputBytes) {
          (isStdout ? process.stdout : process.stderr).write(data);
        } else {
          terminate('OUTPUT_LIMIT');
        }
      });
    };
    collect(action.stdout, stdoutHash, true);
    collect(action.stderr, stderrHash, false);
    action.once('close', (code, signal) =>
      finish(
        code,
        signal,
        terminatingReason ?? (code === 0 ? null : classifyAiFailure(diagnostic.toString('utf8'))),
      ),
    );
    action.stdin.end(message.input);
    setTimeout(() => terminate('TIMEOUT'), initial.timeoutMs).unref();
  });

  process.stdin.on('end', () =>
    terminate(action ? 'PARENT_DISCONNECTED' : 'START_NOT_ACKNOWLEDGED'),
  );
  process.stdin.resume();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  supervise(process.argv[2]).catch((error) => {
    try {
      sendControl({ type: 'supervisor-error', reason: error.message.slice(0, 200) });
    } catch {
      // There may be no control pipe when invoked incorrectly.
    }
    process.exitCode = 1;
  });
}
