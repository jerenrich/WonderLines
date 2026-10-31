// Either service can veto. A rejection closes the gate immediately; an approval
// waits a bounded grace period for the other service's decision. A single
// approval stands only when the other service fails or stays silent through
// that grace. Completion observes both services independently until their
// shared deadline; callers retain it with waitUntil.
export const MODERATION_OVERALL_MS = 8000;
// Covers every recorded non-outage Clef response (max 3.77 s) after a typical
// sub-second Jev approval, while bounding the delay a stalled service can add.
export const SECOND_DECISION_GRACE_MS = 4000;

export function runParallelModeration(services, {
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (services.length !== 2 || new Set(services.map(service => service.id)).size !== 2) {
    throw new Error('Two distinct moderation services are required');
  }
  const started = now(), deadline = started + MODERATION_OVERALL_MS;
  const controllers = services.map(() => new AbortController());
  const results = services.map(() => null);
  let timer, graceTimer, graceDeadline = null, approvedBy = null, completed = false, gate, resolveDecision, resolveCompletion;
  const decision = new Promise(resolve => { resolveDecision = resolve; });
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const elapsed = () => Math.max(0, now() - started);
  const snapshot = pending => services.map((service, index) => ({id: service.id,
    ...(results[index] ?? {outcome: pending, elapsedMs: elapsed()})}));
  const decide = (allowed, decisionReason, reasonCodes = [], approver) => {
    if (gate) return;
    clearTimer(graceTimer);
    gate = {allowed, reasonCodes, decisionReason, elapsedMs: elapsed(),
      ...(approver ? {approvedBy: approver} : {}), providers: snapshot('pending')};
    resolveDecision(gate);
  };
  const approveAlone = () => decide(true, 'single_approval', [], approvedBy);
  const finish = completionReason => {
    if (completed) return;
    completed = true;
    clearTimer(timer);
    if (!gate) {
      const rejected = results.filter(result => result?.outcome === 'rejected');
      if (rejected.length) decide(false, 'rejected', [...new Set(rejected.flatMap(result => result.reasonCodes))]);
      else if (approvedBy) approveAlone();
      else decide(null, completionReason === 'overall_timeout' ? 'overall_timeout' : 'both_unavailable');
    }
    const outcomes = results.map(result => result.outcome);
    const available = outcomes.filter(outcome => ['approved', 'rejected'].includes(outcome)).length;
    resolveCompletion({...gate, elapsedMs: elapsed(), decisionElapsedMs: gate.elapsedMs,
      completionReason, providers: snapshot('timed_out'),
      agreement: available < 2 ? 'incomplete' : outcomes[0] === outcomes[1] ? 'agree' : 'disagree',
      availability: available === 2 ? 'both_available' : available === 1 ? 'partial' : 'unavailable'});
  };
  const expire = () => {
    for (let index = 0; index < results.length; index++) {
      if (results[index]) continue;
      results[index] = {outcome: 'timed_out', elapsedMs: elapsed(), failure: 'timeout'};
      controllers[index].abort();
    }
    finish('overall_timeout');
  };
  const arm = () => { timer = setTimer(() => now() >= deadline ? expire() : arm(), Math.max(0, deadline - now())); };
  const armGrace = () => { graceTimer = setTimer(() => {
    if (gate) return;
    if (now() >= graceDeadline) approveAlone(); else armGrace();
  }, Math.max(0, graceDeadline - now())); };
  const complete = (index, result) => {
    if (completed || results[index]) return;
    // Responses arriving on/after the monotonic cutoff cannot change either
    // the gate or the final observation, even if the timer callback is delayed.
    if (now() >= deadline) { expire(); return; }
    // Likewise, a decision on/after the grace cutoff is observed but cannot
    // overturn the standing approval.
    if (!gate && graceDeadline !== null && now() >= graceDeadline) approveAlone();
    results[index] = {...result, elapsedMs: elapsed()};
    const other = results[1 - index];
    if (result.outcome === 'rejected') decide(false, 'rejected', result.reasonCodes);
    else if (result.outcome === 'approved') {
      if (other?.outcome === 'approved') decide(true, 'both_approved');
      else if (other?.outcome === 'unavailable') { approvedBy = services[index].id; approveAlone(); }
      else if (!gate) {
        approvedBy = services[index].id;
        graceDeadline = Math.min(now() + SECOND_DECISION_GRACE_MS, deadline);
        armGrace();
      }
    } else if (other?.outcome === 'approved') approveAlone(); // this service failed
    if (results.every(Boolean)) finish('all_completed');
  };
  arm();
  services.forEach((service, index) => {
    Promise.resolve().then(() => service.run(controllers[index].signal)).then(result => {
      if (typeof result?.allowed !== 'boolean') {
        complete(index, {outcome: 'unavailable', failure: 'invalid_response'}); return;
      }
      complete(index, {outcome: result.allowed ? 'approved' : 'rejected',
        scores: result.scores, reasonCodes: result.reasonCodes ?? []});
    }, error => {
      const diagnostics = error?.diagnostics ?? {};
      const failure = ['configuration', 'upstream', 'invalid_response', 'timeout'].includes(diagnostics.failure)
        ? diagnostics.failure : 'upstream';
      complete(index, {outcome: 'unavailable', failure,
        ...(['network_error', 'http_error', 'content_type', 'invalid_json', 'model_mismatch', 'invalid_scores', 'response_too_large'].includes(diagnostics.failureDetail)
          ? {failureDetail: diagnostics.failureDetail} : {}),
        ...(Number.isInteger(diagnostics.httpStatus) ? {httpStatus: diagnostics.httpStatus} : {}),
        ...(Number.isInteger(diagnostics.upstreamCode) ? {upstreamCode: diagnostics.upstreamCode} : {}),
      });
    });
  });
  return {decision, completion};
}
