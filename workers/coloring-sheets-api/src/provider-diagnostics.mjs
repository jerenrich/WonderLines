// Provider messages can echo entire prompts, credentials and image data. Never
// log, truncate, hash or forward them. Emit only fixed diagnostic vocabulary.
const RULES = [
  ['unsupported_queue', /(?:does not support|unsupported|not supported).{0,40}(?:request queu|queue request|queuing|queueing)|(?:request queu|queue request|queuing|queueing).{0,40}(?:not supported|unsupported)/i],
  ['missing_required_input', /missing required (?:input|parameter|field)|(?:field|parameter|input).{0,30}(?:is required|must be provided)/i],
  ['invalid_model_input', /model input is not valid|invalid (?:model input|input|parameter)|validation error|failed (?:input )?validation/i],
  ['invalid_dimensions', /(?:width|height|dimensions|image size).{0,50}(?:must|invalid|exceed|too large|too small|multiple of)/i],
  ['prompt_too_long', /(?:prompt|input text).{0,30}(?:too long|exceeds.{0,20}(?:length|limit)|maximum length)/i],
  ['safety_rejected', /nsfw|content policy|safety (?:filter|check|violation)|content.{0,20}(?:flagged|blocked|not allowed)/i],
  ['out_of_memory', /out of memory|cuda.{0,20}(?:memory|oom)|resource exhausted.*memory/i],
  ['capacity_exceeded', /out of capacity|capacity (?:temporarily )?exceeded|no available (?:capacity|replica|gpu)/i],
  ['rate_limited', /rate limit|too many requests/i],
  ['quota_exhausted', /daily free allocation|insufficient.{0,20}(?:credit|quota)|billing.{0,20}limit|quota.{0,20}exhausted/i],
  ['provider_timeout', /timed? ?out|timeout|deadline exceeded/i],
  ['model_unavailable', /no such model|model.{0,30}(?:not found|unavailable|not loaded)/i],
  ['inference_failed', /inference (?:error|failed|failure)|failed to (?:execute|run).{0,20}model|internal (?:server )?error/i],
  ['tensor_shape_mismatch', /(?:tensor|matrix).{0,60}(?:shape|size).{0,40}(?:mismatch|incompatible)|shapes? cannot be multiplied/i],
];
const PARAMETERS = new Set(['prompt','negative_prompt','width','height','steps','num_steps','num_inference_steps','guidance','guidance_scale','seed','image','image_size','mask','mask_image','model','n','quality','output_format','queueRequest','queue_request']);

export function providerErrorDiagnostics(body) {
  const errors = [body?.error, ...(Array.isArray(body?.errors) ? body.errors : []),
    ...(Array.isArray(body?.detail) ? body.detail : [])].filter(Boolean).slice(0, 8);
  const reasons = new Set(), parameters = new Set();
  for (const error of errors) {
    const message = typeof error === 'string' ? error : error.message ?? error.msg;
    if (typeof message === 'string') {
      for (const [reason, pattern] of RULES) if (pattern.test(message)) reasons.add(reason);
      // Extract only names from this fixed set; never return the submitted value.
      for (const match of message.matchAll(/(?:missing required (?:input|parameter|field)|(?:invalid|unknown|unsupported) (?:parameter|field))\s*[:=]?\s*["'`]?([a-zA-Z_][a-zA-Z_0-9]*)/gi)) {
        if (PARAMETERS.has(match[1])) parameters.add(match[1]);
      }
    }
    for (const parameter of [error?.param, error?.parameter, error?.field, ...(Array.isArray(error?.loc) ? error.loc : [])]) {
      if (PARAMETERS.has(parameter)) parameters.add(parameter);
    }
  }
  return {upstreamErrorReasons: [...reasons], upstreamErrorParameters: [...parameters],
    upstreamErrorDetailStatus: reasons.size ? 'classified' : errors.length ? 'unclassified' : 'unavailable'};
}
