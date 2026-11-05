// A visual-step draft: only explicitly approved, guest-redacted frames may be retained.
export class VisualDemonstration {
  constructor({ captureRedacted, clock = () => Date.now() }) {
    this.captureRedacted = captureRedacted;
    this.clock = clock;
    this.session = null;
    this.candidate = null;
  }
  start({ botId, objective, manualControl }) {
    if (!manualControl || this.session || !objective?.trim())
      throw Error('Explicit manual control and intended result required');
    this.session = {
      botId,
      objective: objective.trim(),
      state: 'recording',
      steps: [],
      startedAt: this.clock(),
    };
  }
  sensitiveInput() {
    if (this.session?.state === 'recording') this.session.state = 'paused';
    this.candidate = null;
  }
  pause() {
    if (this.session) this.session.state = 'paused';
    this.candidate = null;
  }
  resume({ botId, manualControl, safeScreenConfirmed }) {
    if (!this.session || this.session.botId !== botId || !manualControl || !safeScreenConfirmed)
      throw Error('Confirm safe screen and control of the same agent');
    this.session.state = 'recording';
  }
  async capture({
    botId,
    frameId,
    crop,
    masks,
    purpose,
    target,
    expectedResult,
    safeScreenConfirmed,
  }) {
    const s = this.session;
    if (
      !s ||
      s.state !== 'recording' ||
      s.botId !== botId ||
      !safeScreenConfirmed ||
      !purpose?.trim() ||
      !target?.trim() ||
      !expectedResult?.trim()
    )
      throw Error('Name the safe target, action and expected result first');
    const frame = await this.captureRedacted({ botId, frameId, crop, masks });
    if (this.session !== s || s.state !== 'recording') return false;
    if (
      frame.redacted !== true ||
      typeof frame.image !== 'string' ||
      frame.image.length > 4 * 1024 * 1024 ||
      !['image/jpeg', 'image/png'].includes(frame.mimeType)
    )
      throw Error('Guest-redacted bounded frame required');
    this.candidate = { purpose, target, expectedResult, frame };
    return true;
  }
  approveCandidate({ reviewedNoSecrets }) {
    if (!this.candidate || reviewedNoSecrets !== true)
      throw Error('Review the redacted frame before accepting');
    this.session.steps.push(this.candidate);
    this.candidate = null;
  }
  discardCandidate() {
    this.candidate = null;
  }
  stop() {
    if (!this.session) throw Error('No recording');
    this.session.state = 'review';
    this.candidate = null;
    return this.draft();
  }
  draft() {
    const s = this.session;
    if (!s) throw Error('No demonstration');
    return {
      botId: s.botId,
      objective: s.objective,
      steps: s.steps.map((step, index) => ({
        index: index + 1,
        purpose: step.purpose,
        target: step.target,
        expectedResult: step.expectedResult,
        frame: step.frame,
      })),
      instructions:
        `Intended result: ${s.objective}\n` +
        s.steps
          .map(
            (x, i) =>
              `${i + 1}. ${x.purpose}. Target: ${x.target}. Verify: ${x.expectedResult}. Compare the reviewed visual example with a fresh live screenshot.`,
          )
          .join('\n') +
        '\nSensitive values are manual-only. Retain action approvals. Never blindly replay coordinates.',
    };
  }
  discard() {
    this.candidate = null;
    this.session = null;
  }
}
