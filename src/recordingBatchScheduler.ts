import { RECORDING_BATCH_START_CONCURRENCY } from '../shared/recordingScript.js';

function isAzureBackoff(error: unknown): error is Error & { status: 429 | 504; retryAfterMs?: number } {
  return error instanceof Error && 'status' in error && (error.status === 429 || error.status === 504);
}

const PROBE_HOLD_MS = 60_000;

export class RecordingBatchScheduler {
  private readonly queue: Array<{ start: () => void; reject: (error: Error) => void }> = [];
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

  async request<T extends { done: boolean }>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.enqueue(send, attempt); }
      catch (error) {
        if (this.closed || !isAzureBackoff(error) || attempt >= 3) throw error;
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const queued of this.queue.splice(0)) queued.reject(new Error('Recording batch scheduling stopped.'));
  }

  private enqueue<T extends { done: boolean }>(send: () => Promise<T>, attempt: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Recording batch scheduling stopped.')); return; }
      this.queue.push({
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
            if (!this.closed && isAzureBackoff(error)) {
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
              const providerDelay = error.retryAfterMs ?? 0;
              const delay = Math.min(2_147_483_647, Math.max(providerDelay, this.baseDelayMs * 2 ** attempt));
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
    if (this.closed || !this.queue.length) return;
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.drain(), wait);
      return;
    }
    if (this.cooldownUntil) {
      this.cooldownUntil = 0;
      this.onChange(this.limit, 0);
    }
    while (this.active < this.limit && this.queue.length) this.queue.shift()?.start();
  }
}
