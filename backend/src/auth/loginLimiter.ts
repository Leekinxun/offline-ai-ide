interface PairBucket {
  failures: number;
  updatedAt: number;
  blockedUntil: number;
}

interface IpBucket {
  failures: number;
  windowStart: number;
  updatedAt: number;
  blockedUntil: number;
}

export type LoginStart =
  | { allowed: false; retryAfterSeconds: number }
  | { allowed: true; finish: (success: boolean | null) => void };

/** An in-process guard for expensive password KDF work. A global in-flight
 * limit preserves libuv threads for live runs, while per-IP and per-IP/user
 * buckets slow guesses without locking an account across every source IP. */
export class LoginLimiter {
  private pairs = new Map<string, PairBucket>();
  private ips = new Map<string, IpBucket>();
  private inFlight = 0;
  private starts = 0;

  constructor(private readonly now: () => number = Date.now, private readonly maxConcurrent = 2) {}

  start(ip: string, username: string): LoginStart {
    const now = this.now();
    this.starts += 1;
    if (this.starts % 128 === 0) this.prune(now);
    const pairKey = `${ip}\u0000${username.toLowerCase()}`;
    const pair = this.pairs.get(pairKey);
    const source = this.ips.get(ip);
    const blockedUntil = Math.max(pair?.blockedUntil || 0, source?.blockedUntil || 0);
    if (blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
    }
    if (this.inFlight >= this.maxConcurrent) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    this.inFlight += 1;
    let finished = false;
    return {
      allowed: true,
      finish: (success) => {
        if (finished) return;
        finished = true;
        this.inFlight -= 1;
        if (success === true) {
          this.pairs.delete(pairKey);
        } else if (success === false) {
          this.recordFailure(ip, pairKey, this.now());
        }
      },
    };
  }

  private recordFailure(ip: string, pairKey: string, now: number): void {
    const previousPair = this.pairs.get(pairKey);
    const pair: PairBucket = previousPair && now - previousPair.updatedAt < 15 * 60_000
      ? previousPair
      : { failures: 0, updatedAt: now, blockedUntil: 0 };
    pair.failures += 1;
    pair.updatedAt = now;
    if (pair.failures >= 5) {
      pair.blockedUntil = now + Math.min(300_000, 1000 * 2 ** Math.min(pair.failures - 5, 9));
    }
    this.pairs.set(pairKey, pair);
    const previousIp = this.ips.get(ip);
    const source: IpBucket = previousIp && now - previousIp.windowStart < 60_000
      ? previousIp
      : { failures: 0, windowStart: now, updatedAt: now, blockedUntil: 0 };
    source.failures += 1;
    source.updatedAt = now;
    if (source.failures >= 120) source.blockedUntil = now + 60_000;
    this.ips.set(ip, source);
    if (this.pairs.size > 10_000) this.pairs.delete(this.pairs.keys().next().value!);
    if (this.ips.size > 2_000) this.ips.delete(this.ips.keys().next().value!);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.pairs) {
      if (now - bucket.updatedAt > 15 * 60_000 && now >= bucket.blockedUntil) this.pairs.delete(key);
    }
    for (const [key, bucket] of this.ips) {
      if (now - bucket.updatedAt > 5 * 60_000 && now >= bucket.blockedUntil) this.ips.delete(key);
    }
  }
}

export const loginLimiter = new LoginLimiter();
