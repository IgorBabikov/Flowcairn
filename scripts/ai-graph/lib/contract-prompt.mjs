/** Lossless prompt projection; the immutable contract and execution evidence keep full paths. */
export function contractForPrompt(contract, planning) {
  if (!planning) return contract;
  const scope = JSON.stringify(contract.scope);
  return { ...contract, requirements: contract.requirements.map(requirement => ({
    ...requirement,
    verification: { ...requirement.verification,
      paths: JSON.stringify(requirement.verification.paths) === scope
        ? { sameAs: 'scope' } : requirement.verification.paths },
  })) };
}
