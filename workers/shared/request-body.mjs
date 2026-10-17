export class RequestBodyTooLarge extends Error {}

// Count bytes as they arrive, even when Content-Length is absent or understated.
// Cancel on overflow and never tee the stream into an unread, unbounded copy.
export async function readBoundedBody(request, max) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  try {
    const declared = request.headers.get('Content-Length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > max) throw new RequestBodyTooLarge();
    const chunks = [];
    let length = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) throw new RequestBodyTooLarge();
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    // Cancellation must not delay the rejection while a sender is still uploading.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
