// Read-only billing lookups. Never infer GPU billing from queue/wall-clock time.
const BASE = 'https://api.fal.ai/v1/models/';
const ENDPOINT = 'fal-ai/lora';
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
async function lookup(env, path) {
  try {
    const response = await fetch(BASE + path, {headers: {Authorization: 'Key ' + env.FAL_KEY},
      redirect: 'manual', signal: AbortSignal.timeout(5000)});
    if (!response.ok) { await response.body?.cancel(); return {status: 'http_' + response.status}; }
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536) { await reader.cancel(); return {status: 'invalid_response'}; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return {status: 'available', data: JSON.parse(new TextDecoder().decode(bytes))};
  } catch { return {status: 'unavailable'}; }
}

export async function falCostData(env, requestID, billableUnits = null, createdAt = Date.now()) {
  const capturedAt = new Date().toISOString();
  if (typeof requestID !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestID)) {
    return {costCheckedAt: capturedAt, billingLookupStatus: 'no_request_id'};
  }
  const endpoint = encodeURIComponent(ENDPOINT);
  const [pricing, billing] = await Promise.all([
    lookup(env, 'pricing?endpoint_id=' + endpoint),
    lookup(env, 'billing-events?endpoint_id=' + endpoint + '&request_id=' + encodeURIComponent(requestID) +
      '&start=' + encodeURIComponent(new Date(createdAt - 60000).toISOString()) + '&limit=10')
  ]);
  const price = Array.isArray(pricing.data?.prices) ? pricing.data.prices.find(row => row?.endpoint_id === ENDPOINT) : null;
  const validPrice = price?.currency === 'USD' && nonnegative(price.unit_price) &&
    typeof price.unit === 'string' && /^[a-zA-Z0-9 _./-]{1,64}$/.test(price.unit);
  const events = billing.data?.billing_events;
  // Only use an exact, unique request match. Ambiguous/paginated data is not a receipt.
  const matches = Array.isArray(events) ? events.filter(row => row?.request_id === requestID && row.endpoint_id === ENDPOINT) : [];
  const event = matches.length === 1 && billing.data.has_more === false ? matches[0] : null;
  const validEvent = event && nonnegative(event.cost_total) && nonnegative(event.cost_subtotal) &&
    nonnegative(event.cost_discount) && Math.abs(event.cost_total + event.cost_discount - event.cost_subtotal) < 0.000001;
  return {providerRequestID: requestID, costCheckedAt: capturedAt,
    billableUnits: validEvent && nonnegative(event.output_units) ? event.output_units : nonnegative(billableUnits) ? billableUnits : null,
    unitPriceUsd: validEvent && nonnegative(event.unit_price) ? event.unit_price : validPrice ? price.unit_price : null,
    billingUnit: validPrice ? price.unit : null,
    reportedCostUsd: validEvent ? event.cost_total : null,
    reportedCostSubtotalUsd: validEvent ? event.cost_subtotal : null,
    reportedDiscountUsd: validEvent ? event.cost_discount : null,
    pricingLookupStatus: validPrice ? 'available' : pricing.status === 'available' ? 'invalid_response' : pricing.status,
    billingLookupStatus: validEvent ? 'available' : billing.status === 'available' ? 'not_reported' : billing.status};
}
