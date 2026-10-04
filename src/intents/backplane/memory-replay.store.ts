import { ReplayStore, ReplaySinceResult, SequencedEvent } from './replay-store';

interface StoredEntry {
  event: SequencedEvent;
  timestamp: number;
}

/**
 * In-process replay store backed by a capped array.
 *
 * Eviction policy (evaluated on every append):
 *  1. Count-based: if the buffer exceeds `maxCount`, the oldest entries are
 *     dropped first.
 *  2. Age-based: if `maxAgeMs` is set, entries older than
 *     `Date.now() - maxAgeMs` are dropped.
 */
export class MemoryReplayStore implements ReplayStore {
  private readonly buf: StoredEntry[] = [];
  private readonly maxCount: number;
  private readonly maxAgeMs?: number;

  constructor(opts: { maxCount: number; maxAgeMs?: number }) {
    this.maxCount = opts.maxCount;
    this.maxAgeMs = opts.maxAgeMs;
  }

  async append(event: SequencedEvent): Promise<void> {
    const timestamp = Date.now();
    this.buf.push({ event, timestamp });

    // Count-based eviction.
    while (this.buf.length > this.maxCount) {
      this.buf.shift();
    }

    // Age-based eviction.
    if (this.maxAgeMs !== undefined) {
      const cutoff = Date.now() - this.maxAgeMs;
      while (this.buf.length > 0 && this.buf[0].timestamp < cutoff) {
        this.buf.shift();
      }
    }
  }

  async since(fromSeq: number): Promise<ReplaySinceResult> {
    if (this.buf.length === 0) {
      return { events: [], tooOld: false };
    }

    const oldest = this.buf[0].event.seq;

    // If fromSeq is older than the oldest retained entry, the gap cannot be
    // bridged — the caller must request a fresh snapshot.
    if (fromSeq < oldest - 1) {
      return { events: [], tooOld: true };
    }

    const events = this.buf
      .map((e) => e.event)
      .filter((e) => e.seq > fromSeq);

    return { events, tooOld: false };
  }

  async latestSeq(): Promise<number> {
    if (this.buf.length === 0) return 0;
    return this.buf[this.buf.length - 1].event.seq;
  }

  async oldestSeq(): Promise<number> {
    if (this.buf.length === 0) return -1;
    return this.buf[0].event.seq;
  }
}
