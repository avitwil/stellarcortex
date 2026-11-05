// Explicit simulation outcomes; these never assert real coding or test evidence.
export function createSyntheticKanbanExecutor({
  delayMs = 1200,
  validation = () => ({
    passed: true,
    evidence: 'Configured simulated validation passed; no real tests were run.',
  }),
} = {}) {
  const execute = async ({ card }) => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    let kind, evidence;
    if (card.stage === 'specification') {
      kind = 'specification-ready';
      evidence = 'Simulated specification prepared for user approval; no model was called.';
    } else if (card.stage === 'development') {
      kind = 'development-completed';
      evidence =
        'Simulated development outcome; no code was written. A separate simulated validation stage is required.';
    } else if (card.stage === 'testing') {
      const result = await validation(card);
      if (typeof result?.passed !== 'boolean' || typeof result.evidence !== 'string')
        throw Error('Explicit simulated validation outcome required');
      kind = result.passed ? 'validation-passed' : 'validation-failed';
      evidence = result.evidence;
    } else if (card.stage === 'in-progress') {
      kind = 'task-completed';
      evidence = 'Simulated task outcome ready for user review; no external action was performed.';
    } else throw Error('Unsupported simulated stage');
    return { synthetic: true, text: evidence, workflow: { kind, evidence, simulated: true } };
  };
  execute.simulated = true;
  return execute;
}
