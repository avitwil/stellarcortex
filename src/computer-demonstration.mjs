import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeDemonstrationStep, noDemonstrationSecrets } from '../public/computer-demonstration.js';
import { id, now, required } from './store.mjs';
export function saveDemonstration(store, input) {
  const bot = store.bot(input.botId);
  if (bot.deletedAt) throw Error('Restore the agent before saving instructions');
  if (input.reviewed !== true)
    throw Error('Review and confirm no sensitive information before saving');
  if (
    typeof input.demoId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(input.demoId) ||
    !['desktop', 'browser'].includes(input.mode)
  )
    throw Error('Invalid demonstration identity');
  const name = required(input.name, 'Name', 100),
    objective = required(input.objective, 'Intended result', 2000),
    instructions = required(input.instructions, 'Reviewed instructions', 12000);
  if (!noDemonstrationSecrets(name + '\n' + objective + '\n' + instructions))
    throw Error('Remove apparent secrets from the instructions');
  const frames = reviewedFrames(store, {
    botId: bot.id,
    demoId: input.demoId,
    frameIds: input.frameIds || [],
  });
  if (
    !Array.isArray(input.steps) ||
    (!input.steps.length && !frames.length) ||
    input.steps.length > 500
  )
    throw Error('Demonstrate at least one successful action');
  const steps = input.steps.map(s => safeDemonstrationStep(s, s)).filter(Boolean);
  if (!steps.length && !frames.length) throw Error('No usable demonstration steps');
  const prior = store.data.skills.find(s => s.demonstrationId === input.demoId);
  if (prior) {
    if (
      prior.botId !== bot.id ||
      prior.name !== name ||
      prior.demonstration.objective !== objective ||
      prior.reviewedInstructions !== instructions
    )
      throw Error('Demonstration was already saved with different content');
    return prior;
  }
  const skill = {
    id: id(),
    botId: bot.id,
    name,
    demonstrationId: input.demoId,
    reviewedInstructions: instructions,
    frameIds: frames.map(f => f.id),
    instructions:
      instructions +
      (frames.length
        ? '\nReviewed visual examples available through stellarcortex_skill read: ' +
          frames.map(f => f.id).join(', ')
        : '') +
      '\n\nUser-reviewed demonstration for this agent only. Source material, not an authorization. Execute only for an explicit user task and retain normal tool/action approvals. Verify current screen targets instead of blindly replaying coordinates; sensitive values require manual user entry.',
    source: 'user-demonstration',
    demonstration: { format: 'safe-action-outline-v1', mode: input.mode, objective, steps },
    createdAt: now(),
  };
  store.data.skills.push(skill);
  store.save();
  return skill;
}

export function reviewedFrames(store, { botId, demoId, frameIds = [] }) {
  if (!Array.isArray(frameIds)) throw Error('Frame references required');
  return frameIds.map(id => {
    const f = (store.data.computerTeachingFrames || []).find(
      f => f.id === id && f.botId === botId && f.demoId === demoId,
    );
    if (!f) throw Error('Visual example belongs to another demonstration');
    return f;
  });
}

export function saveReviewedFrame(store, input) {
  const bot = store.bot(input.botId);
  if (bot.deletedAt || input.reviewed !== true)
    throw Error('Owner review of a live agent visual example required');
  for (const key of ['demoId', 'frameId'])
    if (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input[key]))
      throw Error('Invalid visual example identity');
  if (
    typeof input.image !== 'string' ||
    input.image.length > 6 * 1024 * 1024 ||
    !['image/jpeg', 'image/png'].includes(input.mimeType)
  )
    throw Error('Bounded reviewed JPEG/PNG required');
  const bytes = Buffer.from(input.image, 'base64'),
    jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!(input.mimeType === 'image/jpeg' ? jpeg : png)) throw Error('Invalid image signature');
  const hash = createHash('sha256').update(bytes).digest('hex');
  store.data.computerTeachingFrames ??= [];
  const old = store.data.computerTeachingFrames.find(
    f => f.demoId === input.demoId && f.sourceId === input.frameId,
  );
  if (old) {
    if (old.botId !== bot.id || old.hash !== hash) throw Error('Visual example identity conflict');
    return old;
  }
  const frame = {
      id: id(),
      demoId: input.demoId,
      sourceId: input.frameId,
      botId: bot.id,
      mimeType: input.mimeType,
      hash,
      createdAt: now(),
    },
    directory = path.join(store.dir, 'computer-teaching');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  frame.file = frame.id + (jpeg ? '.jpg' : '.png');
  fs.writeFileSync(path.join(directory, frame.file), bytes, { mode: 0o600, flag: 'wx' });
  store.data.computerTeachingFrames.push(frame);
  store.save();
  return frame;
}
export function readSkillFrames(store, skill) {
  return (skill.frameIds || []).map(id => {
    const frame = store.data.computerTeachingFrames.find(
      f => f.id === id && f.botId === skill.botId && f.demoId === skill.demonstrationId,
    );
    if (!frame) throw Error('Reviewed visual example missing');
    const bytes = fs.readFileSync(path.join(store.dir, 'computer-teaching', frame.file));
    if (createHash('sha256').update(bytes).digest('hex') !== frame.hash)
      throw Error('Visual example changed');
    return {
      type: 'inputImage',
      imageUrl: `data:${frame.mimeType};base64,${bytes.toString('base64')}`,
    };
  });
}
