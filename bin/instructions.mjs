import { GraphError } from '../scripts/ai-graph/lib/io.mjs';

/** Command adapter only. Rules ownership and mutations stay in the shared domain modules. */
export async function instructionsCommand(projectRoot, action, options = {}, loader = async () => ({
  ...await import('../scripts/ai-graph/lib/instructions.mjs'),
  ...await import('../scripts/ai-graph/lib/integration.mjs'),
})) {
  if (!['inspect', 'activate'].includes(action))
    throw new GraphError('ARGUMENT', 'Используйте instructions inspect или instructions activate --fingerprint HASH --consent.');
  const api = await loader();
  if (action === 'inspect' || options['dry-run'])
    return {
      instructions: api.inspectInstructions({ projectRoot }),
      integration: api.inspectIntegration({ projectRoot }),
      changed: false,
    };
  if (options.consent !== true || !/^[a-f0-9]{64}$/.test(options.fingerprint ?? ''))
    throw new GraphError('INTEGRATION_CONSENT', 'Сначала instructions inspect. Для активации нужны --fingerprint HASH из текущей проверки и --consent.');
  return api.activateIntegration({ projectRoot, consent: true, expectedFingerprint: options.fingerprint });
}
