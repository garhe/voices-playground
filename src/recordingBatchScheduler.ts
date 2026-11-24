import { RECORDING_BATCH_START_CONCURRENCY } from '../shared/recordingScript.js';

function isRetryable(error: unknown): error is Error & { status: number; retryAfterMs?: number } {
  return error instanceof Error && 'status' in error && typeof error.status === 'number'
    && [422, 429, 500, 502, 503, 504].includes(error.status);
}

const PROBE_HOLD_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export type RecordingBatchRetry = { attempt: number; retryAt: number; message: string };

export class RecordingBatchScheduler {
  private readonly queue: Array<{ readyAt: number; start: () => void; reject: (error: Error) => void }> = [];
  private limit: number;
  private active = 0;
  private successes = 0;
  private lastStableLimit?: number;
  private cooldownUntil = 0;
  private probeAfter = 0;
  private epoch = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly ceiling: number, private readonly onChange: (limit: number, cooldownUntil: number) => void,
    private readonly baseDelayMs = 5000) {
    this.limit = Math.min(ceiling, RECORDING_BATCH_START_CONCURRENCY);
    onChange(this.limit, 0);
  }

  async request<T extends { done: boolean }>(send: () => Promise<T>, onRetry?: (retry: RecordingBatchRetry) => void): Promise<T> {
    let readyAt = 0;
    for (let attempt = 0; ; attempt++) {
      try { return await this.enqueue(send, attempt, readyAt); }
      catch (error) {
        if (this.closed || !isRetryable(error)) throw error;
        readyAt = Math.max(this.cooldownUntil, Date.now() + this.retryDelay(attempt, error.retryAfterMs));
        onRetry?.({ attempt: attempt + 1, retryAt: readyAt, message: error.message });
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const queued of this.queue.splice(0)) queued.reject(new Error('Recording batch scheduling stopped.'));
  }

  private retryDelay(attempt: number, providerDelay = 0) {
    return Math.max(Math.min(MAX_TIMER_MS, providerDelay), Math.min(MAX_BACKOFF_MS, this.baseDelayMs * 2 ** Math.min(attempt, 16)));
  }

  private enqueue<T extends { done: boolean }>(send: () => Promise<T>, attempt: number, readyAt: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Recording batch scheduling stopped.')); return; }
      this.queue.push({
        readyAt,
        reject,
        start: () => {
          const epoch = this.epoch;
          const limitAtStart = this.limit;
          this.active++;
          void Promise.resolve().then(send).then(result => {
            // A completed checkpoint can be returned without making an Azure request.
            if (!this.closed && !result.done && epoch === this.epoch && limitAtStart === this.limit && this.limit < this.ceiling) {
              this.successes++;
              if (this.successes >= this.limit && Date.now() >= this.probeAfter) {
                this.lastStableLimit = this.limit;
                this.limit++;
                this.successes = 0;
                this.onChange(this.limit, 0);
              }
            }
            resolve(result);
          }, (error: unknown) => {
            if (!this.closed && isRetryable(error) && (error.status === 429 || error.status === 504)) {
              if (epoch === this.epoch) {
                this.epoch++;
                if (this.lastStableLimit !== undefined && this.lastStableLimit < limitAtStart) {
                  this.limit = this.lastStableLimit;
                } else {
                  this.lastStableLimit = undefined;
                  this.limit = Math.max(1, Math.floor(limitAtStart / 2));
                }
                this.successes = 0;
              }
              const delay = this.retryDelay(attempt, error.retryAfterMs);
              this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
              this.probeAfter = this.cooldownUntil + PROBE_HOLD_MS;
              this.onChange(this.limit, this.cooldownUntil);
            }
            reject(error);
          }).finally(() => {
            this.active--;
            this.drain();
          });
        },
      });
      this.drain();
    });
  }

  private drain() {
    clearTimeout(this.timer);
    if (this.closed) return;
    const now = Date.now();
    const wait = this.cooldownUntil - now;
    if (wait > 0) {
      if (this.queue.length) this.timer = setTimeout(() => this.drain(), wait);
      return;
    }
    if (this.cooldownUntil) {
      this.cooldownUntil = 0;
      this.onChange(this.limit, 0);
    }
    while (this.active < this.limit && this.queue.length) {
      const index = this.queue.findIndex(item => item.readyAt <= now);
      if (index < 0) {
        const next = Math.min(...this.queue.map(item => item.readyAt));
        this.timer = setTimeout(() => this.drain(), next - now);
        return;
      }
      this.queue.splice(index, 1)[0].start();
    }
  }
}
