/** Lossless prompt projection; the immutable contract and execution evidence keep full paths. */
export function contractForPrompt(contract, planning, taskReference = null, task = null) {
  if (!planning && !taskReference) return contract;
  const scope = JSON.stringify(contract.scope);
  return { ...contract, requirements: contract.requirements.map(requirement => ({
    ...requirement,
    ...(taskReference && task?.acceptance.includes(requirement.title) ? { title: { source: taskReference, acceptanceIndex: task.acceptance.indexOf(requirement.title) } } : {}),
    verification: { ...requirement.verification,
      criterion: requirement.verification.criterion === requirement.title ? { sameAs: 'title' } : requirement.verification.criterion,
      paths: JSON.stringify(requirement.verification.paths) === scope
        ? { sameAs: 'scope' } : requirement.verification.paths },
  })) };
}
