export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }),
};

export const sleep = (ms: number, signal?: AbortSignal) => systemClock.sleep(ms, signal);
