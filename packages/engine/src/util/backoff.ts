import { sleep } from "./time";

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: boolean;
}

/** Full-jitter exponential backoff delay for attempt n (0-based). */
export function backoffDelay(attempt: number, o: BackoffOptions = {}): number {
  const base = o.baseMs ?? 250;
  const max = o.maxMs ?? 30_000;
  const exp = Math.min(max, base * Math.pow(o.factor ?? 2, attempt));
  return o.jitter === false ? exp : Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  o: BackoffOptions & { retries?: number; retryIf?: (err: unknown) => boolean; signal?: AbortSignal; onRetry?: (err: unknown, attempt: number, delay: number) => void } = {},
): Promise<T> {
  const retries = o.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || (o.retryIf && !o.retryIf(err)) || o.signal?.aborted) throw err;
      const delay = backoffDelay(attempt, o);
      o.onRetry?.(err, attempt, delay);
      await sleep(delay, o.signal);
    }
  }
}
