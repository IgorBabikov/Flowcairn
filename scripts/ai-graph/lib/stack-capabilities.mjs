import { validateCheckProfile } from './check-profile.mjs';
import { discoverStackProfile } from './stack-profile.mjs';
import { validateDevelopmentWorkflow } from './development-workflow.mjs';

/** Host-side metadata for fresh owner registration. Never executes a config or test.
 * A report format identifies an available verifier recipe, not its semantic adequacy
 * or successful execution. Generic test reports need one unambiguous scoped domain.
 */
export function inferDevelopmentCapabilities(root, { checkProfile, manifestPaths = [], readConsent = false }) {
  const profile = validateCheckProfile(checkProfile);
  const inferred = new Map();
  const add = (id, check) => {
    const entry = inferred.get(id) ?? { id, checkIds: [], scope: [] };
    entry.checkIds.push(check.id);
    entry.scope.push(check.command.cwd);
    inferred.set(id, entry);
  };
  for (const check of profile.definitions) {
    if (!profile.requiredCheckIds.includes(check.id) || !check.report) continue;
    const format = check.report.format;
    if (format === 'playwright-json') add('browser-scenario', check);
    else if (format === 'flowcairn-xctest/v1') {
      add('mobile-ios-build', check); add('mobile-ios-scenario', check);
    } else if (format === 'flowcairn-android-node/v1') {
      add('mobile-android-build', check); add('mobile-android-scenario', check);
    } else if (readConsent && ['jest-json', 'vitest-json', 'flowcairn-node-test/v1'].includes(format)) {
      const stack = discoverStackProfile(root, { scope: [check.command.cwd], manifestPaths });
      if (stack.domains.length !== 1) continue;
      const domain = stack.domains[0];
      if (domain === 'frontend') add('component-test', check);
      else if (domain === 'mobile') add('mobile-component-test', check);
      else if (domain === 'backend' && format !== 'vitest-json') add('api-integration', check);
    }
  }
  const capabilities = [...inferred.values()].map((entry) => ({ ...entry,
    checkIds: [...new Set(entry.checkIds)].sort(), scope: [...new Set(entry.scope)].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return validateDevelopmentWorkflow({ version: 2, capabilities }, { checks: profile.requiredCheckIds }).capabilities;
}
