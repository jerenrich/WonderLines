// Operational events deliberately exclude prompts, image bodies, credentials,
// object keys and exception/provider response text.
const operations = new Set(['image_write', 'image_read', 'image_missing', 'job_write', 'queue_persistence']);
const identity = generationID => /^[0-9a-f-]{36}$/.test(generationID ?? '') ? {generationID} : {};

export function storageFailure(operation, generationID) {
  console.error(JSON.stringify({event: 'storage_failure', operation: operations.has(operation) ? operation : 'unknown',
    ...identity(generationID)}));
}

export async function observeStorage(operation, generationID, action) {
  try { return await action(); }
  catch (error) { storageFailure(operation, generationID); throw error; }
}

export function generationResult(generationID, state) {
  if (state === 'failed' || state === 'completed') {
    (state === 'failed' ? console.error : console.info)(JSON.stringify({event: 'generation_result',
      outcome: state, ...identity(generationID)}));
  }
}
