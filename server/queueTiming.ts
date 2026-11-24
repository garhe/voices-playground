const WINDOW_MS = 120_000;
const MIN_SAMPLE_MS = 20_000;
const MIN_ASSESSMENTS = 6;

export class QueueTiming {
  private readonly settled: number[] = [];

  constructor(private readonly startedAt: number) {}

  record(now: number) {
    this.prune(now);
    this.settled.push(now);
  }

  minutesLeft(now: number, current: number, queued: number, paused: boolean) {
    this.prune(now);
    const elapsed = Math.min(now - this.startedAt, WINDOW_MS);
    if (elapsed < MIN_SAMPLE_MS || this.settled.length < MIN_ASSESSMENTS) return {};
    const minutes = (remaining: number) => Math.ceil(remaining * elapsed / this.settled.length / 60_000);
    return {
      currentMinutes: current ? minutes(current) : undefined,
      batchMinutes: !paused && current + queued > 0 ? minutes(current + queued) : undefined,
    };
  }

  private prune(now: number) {
    let expired = 0;
    while (expired < this.settled.length && this.settled[expired] < now - WINDOW_MS) expired++;
    if (expired) this.settled.splice(0, expired);
  }
}
