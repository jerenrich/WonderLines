import {moderateSubject, ModerationError} from './moderation.mjs';

export const MODERATION_CANARY_CRON = '* * * * *';
export const MODERATION_CANARY_SUBJECT = 'A cheerful kitten sitting beside a flower in a sunny garden.';

// Exercise the configured production moderators, including the normal deadline
// and uncached requests, without creating accounts, images, reservations or jobs.
export async function runModerationCanary(env, {moderate = moderateSubject, now = Date.now,
  emit = event => (event.outcome === 'failed' ? console.error : console.info)(JSON.stringify(event))} = {}) {
  const started = now(), retained = [];
  let completion, error;
  try {
    await moderate(env, MODERATION_CANARY_SUBJECT, {
      waitUntil: promise => retained.push(promise),
      onComplete: result => { completion = result; },
    });
  } catch (caught) { error = caught; }
  // First approval can precede the other provider's result. Keep that result so
  // successful fallback does not hide persistent loss of redundancy.
  const background = await Promise.allSettled(retained);
  const failed = Boolean(error) || background.some(result => result.status === 'rejected');
  const event = {event: 'moderation_canary', probe: 'fixed_benign_description_v1',
    strategy: env.MODERATION_STRATEGY === 'parallel' ? 'parallel' : 'single',
    outcome: failed ? 'failed' : 'passed', elapsedMs: Math.max(0, Math.round(now() - started)),
    ...(failed ? {failure: error instanceof ModerationError
      ? error.code === 'description_not_suitable' ? 'unexpected_rejection' : 'moderation_unavailable'
      : 'unexpected_error'} : {}),
    ...(['both_available', 'partial', 'unavailable'].includes(completion?.availability)
      ? {availability: completion.availability} : {}),
  };
  emit(event);
  return event;
}
