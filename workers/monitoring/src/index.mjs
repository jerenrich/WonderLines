import {failuresFromTail, advancePolicy} from './policy.mjs';

export default {
  async tail(traces, env) {
    const failures = failuresFromTail(traces, Date.now());
    if (!failures.length) return;
    const stub = env.ALERT_STATE.get(env.ALERT_STATE.idFromName('production'));
    const response = await stub.fetch('https://monitoring/failures', {method: 'POST', body: JSON.stringify(failures)});
    if (!response.ok) throw new Error('Monitoring state unavailable');
    await response.body?.cancel();
  },
};

// This object has no public HTTP route; only the Tail Worker can call it.
// All categories share one durable cooldown, including across deployments.
export class AlertState {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const failures = await request.json();
    const batch = await this.state.storage.transaction(async storage => {
      const {state, batch} = advancePolicy(await storage.get('policy'), failures, Date.now());
      await storage.put('policy', state);
      // Log only after the durable write has committed (below).
      return batch;
    });
    for (const event of batch) console.error(JSON.stringify(event));
    return new Response(null, {status: 204});
  }
}
