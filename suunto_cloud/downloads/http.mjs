export class NetworkError extends Error {}

export class HttpError extends Error {
  constructor(response) {
    super(`Suunto returned HTTP ${response.status}.`);
    this.status = response.status;
    this.retryAfter = response.headers.get('retry-after');
    this.response = response;
  }
}

export async function request(url, init = {}, fetcher = fetch) {
  try {
    return await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new NetworkError('Could not reach Suunto.');
  }
}

export async function jsonResponse(response) {
  if (!response.ok) throw new HttpError(response);
  return response.json();
}

export async function limitedBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  try {
    while (count < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - count);
      count += chunk.length;
      chunks.push(chunk);
    }
  } catch {
    throw new NetworkError('Could not read the Suunto response.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, count);
}
