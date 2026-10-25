export class PollPolicy {
  constructor() {
    this.activeMs = 15000;
    this.queuedMs = 20000;
    this.warmIdleMs = 60000;
    this.idleMs = 120000;
    this.coldMs = 300000;
    this.warmWindowMs = 3600000;
    this.errorBaseMs = 15000;
    this.errorMaxMs = 600000;
  }

  nextInterval(hasActive, hasQueued, ageSinceActivityMs, consecutiveErrors) {
    if (consecutiveErrors > 0) {
      let interval = this.errorBaseMs;
      for (let i = 1; i < consecutiveErrors; i += 1) {
        if (interval >= this.errorMaxMs / 2) return this.errorMaxMs;
        interval *= 2;
      }
      return Math.min(interval, this.errorMaxMs);
    }
    if (hasActive) return this.activeMs;
    if (hasQueued) return this.queuedMs;
    if (ageSinceActivityMs < this.warmWindowMs) return this.warmIdleMs;
    if (ageSinceActivityMs < this.warmWindowMs * 6) return this.idleMs;
    return this.coldMs;
  }
}
