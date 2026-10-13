import { z } from 'zod';
import { Hash, RelativePath, assertJsonBounds } from './schemas.mjs';
import { hashObject } from './io.mjs';
import { parseNodeVerificationReport } from './node-verification-report.mjs';

export const ANDROID_NODE_REPORT_FORMAT = 'flowcairn-android-node/v1';
export const MAX_ANDROID_APK_BYTES = 512 * 1024 * 1024;
const Source = z.strictObject({ path: RelativePath, hash: Hash });
const Envelope = z.strictObject({
  format: z.literal(ANDROID_NODE_REPORT_FORMAT), nodeReport: z.unknown(),
  build: z.strictObject({ completed: z.boolean(), exitCode: z.number().int().nullable(),
    sourceInputs: z.array(Source).min(1).max(4096), toolchainHash: Hash.nullable().optional() }),
  artifact: z.strictObject({ kind: z.literal('apk'), path: RelativePath,
    hash: Hash.nullable(), installedHash: Hash.nullable() }).nullable().optional(),
  environment: z.strictObject({ platform: z.literal('android'), apiLevel: z.number().int().min(1).max(1000),
    abi: z.enum(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']), deviceHash: Hash,
    target: z.enum(['emulator', 'physical']), sessionHash: Hash }).nullable().optional(),
  session: z.strictObject({ ownership: z.literal('task-owned'), deviceHash: Hash, sessionHash: Hash,
    cleanup: z.strictObject({ completed: z.boolean(), stopped: z.boolean(), exitCode: z.number().int().nullable() }) }).nullable().optional(),
});
export { Envelope as AndroidNodeVerificationReportSchema };
const initial = () => ({ version: 1, format: ANDROID_NODE_REPORT_FORMAT, status: 'unverified',
  counts: { total: null, completed: null, passed: null, failed: null, skipped: null }, countsConfirmed: false,
  assertionFailures: 0, scenarios: [], reasons: [], artifact: { status: 'unknown', identity: null, kind: null, path: null },
  environment: { status: 'unknown', identity: null },
  limitations: ['device-driver-oracle-and-SDK-identities-require-trusted-registration', 'report-does-not-prove-arbitrary-requirement-semantics'] });
const reject = (result, code) => { result.reasons.push({ code, kind: 'unverified' }); result.status = 'unverified'; };
const claims = ['retry', 'retries', 'retryCount', 'retryReasons', 'attempt', 'attempts', 'invocations',
  'expectedStatus', 'expectedFailure', 'expectedFailures', 'failing'];

/** Normalize a genuine Node22 device-driver report; host owns source/APK/SDK byte verification. */
export function parseAndroidNodeVerificationReport(value, { requiredScenarios = [] } = {}) {
  const result = initial();
  try {
    assertJsonBounds(value, 100000);
    const parsed = Envelope.safeParse(value);
    if (!parsed.success) { reject(result, 'REPORT_ANDROID_MALFORMED'); return result; }
    const envelope = parsed.data, raw = /** @type {any} */ (envelope.nodeReport);
    if (!raw || !Array.isArray(raw.cases) || raw.cases.length > 1000 ||
        claims.some(key => Object.hasOwn(raw, key)) || raw.cases.some(item => claims.some(key => Object.hasOwn(item, key)))) {
      reject(result, 'REPORT_ANDROID_RETRY_OR_EXPECTATION_UNCONFIRMED'); return result;
    }
    const node = parseNodeVerificationReport(raw, { requiredScenarios });
    Object.assign(result, { status: node.status, counts: node.counts, countsConfirmed: node.countsConfirmed,
      assertionFailures: node.assertionFailures, scenarios: node.scenarios, reasons: [...node.reasons] });
    if (node.reasons.some(reason => reason.kind === 'unverified')) result.status = 'unverified';
    if (node.counts.failed > node.assertionFailures)
      reject(result, 'REPORT_ANDROID_DRIVER_FAILURE_UNVERIFIED');
    if (!envelope.build.completed || envelope.build.exitCode !== 0) reject(result, 'REPORT_ANDROID_BUILD_UNCONFIRMED');
    if (!envelope.build.toolchainHash) reject(result, 'REPORT_ANDROID_SDK_IDENTITY_MISSING');
    if (new Set(envelope.build.sourceInputs.map(item => item.path)).size !== envelope.build.sourceInputs.length)
      reject(result, 'REPORT_ANDROID_SOURCE_INPUT_DUPLICATE');
    if (envelope.artifact?.hash && envelope.artifact.hash === envelope.artifact.installedHash)
      result.artifact = { status: 'reported', identity: envelope.artifact.hash, kind: 'apk', path: envelope.artifact.path };
    else reject(result, 'REPORT_ANDROID_ARTIFACT_IDENTITY_UNCONFIRMED');
    const environment = envelope.environment, session = envelope.session;
    if (!environment || !session || environment.deviceHash !== session.deviceHash || environment.sessionHash !== session.sessionHash)
      reject(result, 'REPORT_ANDROID_DEVICE_SESSION_UNCONFIRMED');
    else result.environment = { status: 'reported', identity: hashObject(environment) };
    if (!session?.cleanup.completed || !session.cleanup.stopped || session.cleanup.exitCode !== 0)
      reject(result, 'REPORT_ANDROID_CLEANUP_UNCONFIRMED');
    if (node.status === 'failed' && result.status !== 'unverified' && !result.reasons.length)
      result.reasons.push({ code: 'REPORT_CASE_FAILED', kind: 'failed' });
    return result;
  } catch {
    const rejected = initial(); reject(rejected, 'REPORT_ANDROID_MALFORMED'); return rejected;
  }
}
