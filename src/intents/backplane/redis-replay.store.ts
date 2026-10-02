import Redis from 'ioredis';
import { ReplayStore, ReplaySinceResult, SequencedEvent } from './replay-store';

/**
 * Redis Streams-backed replay store (issue #457).
 *
 * Uses `ioredis` (the project's existing Redis client) rather than the `redis`
 * npm package which is not installed.
 *
 * Entry IDs use the format `0-{seq}` so XRANGE queries can filter by sequence
 * number directly without loading the full stream.
 *
 * Retention:
 *  - Count-based: XADD MAXLEN ~ maxCount (approximate, for performance).
 *  - Age-based: after each XADD, XTRIM MINID ~ {cutoffMs}-0.
 *
 * Field layout per entry: { data: JSON.stringify(SequencedEvent) }
 */
export class RedisReplayStore implements ReplayStore {
  private readonly client: Redis;
  private readonly streamKey: string;
  private readonly maxCount: number;
  private readonly maxAgeMs?: number;

  constructor(opts: {
    redisUrl: string;
    streamKey: string;
    maxCount: number;
    maxAgeMs?: number;
  }) {
    this.client = new Redis(opts.redisUrl, { lazyConnect: true });
    this.streamKey = opts.streamKey;
    this.maxCount = opts.maxCount;
    this.maxAgeMs = opts.maxAgeMs;
  }

  async append(event: SequencedEvent): Promise<void> {
    const id = `0-${event.seq}`;
    const data = JSON.stringify(event);
    // XADD key MAXLEN ~ maxCount id data jsonStr
    await this.client.xadd(
      this.streamKey,
      'MAXLEN',
      '~',
      this.maxCount,
      id,
      'data',
      data,
    );
    if (this.maxAgeMs !== undefined) {
      const cutoffMs = Date.now() - this.maxAgeMs;
      // XTRIM key MINID ~ {cutoffMs}-0
      await this.client.xtrim(this.streamKey, 'MINID', '~', `${cutoffMs}-0`);
    }
  }

  async since(fromSeq: number): Promise<ReplaySinceResult> {
    const rangeStart = `0-${fromSeq + 1}`;
    const entries = await this.client.xrange(this.streamKey, rangeStart, '+');

    // entries: Array<[id: string, fields: string[]]>
    // fields is a flat array: ['data', '<json>', ...]
    const events: SequencedEvent[] = entries.map(([, fields]) => {
      // ioredis returns fields as a flat alternating key/value array
      const dataIdx = fields.indexOf('data');
      const raw = dataIdx >= 0 ? fields[dataIdx + 1] : '{}';
      return JSON.parse(raw) as SequencedEvent;
    });

    // fromSeq===0 means "from the very beginning" — never tooOld.
    if (fromSeq === 0) {
      return { events, tooOld: false };
    }

    // Detect a gap: if the first returned seq > fromSeq+1, some history was trimmed.
    const firstSeq = events.length > 0 ? events[0].seq : null;
    if (firstSeq !== null && firstSeq > fromSeq + 1) {
      return { events: [], tooOld: true };
    }

    if (events.length === 0) {
      // No entries >= fromSeq+1.  Check if the stream has any entries at all.
      const oldest = await this.oldestSeq();
      if (oldest !== -1) {
        // Stream has data but none matches — history was trimmed past fromSeq.
        return { events: [], tooOld: true };
      }
      // Stream is completely empty.
      return { events: [], tooOld: false };
    }

    return { events, tooOld: false };
  }

  async latestSeq(): Promise<number> {
    const entries = await this.client.xrevrange(this.streamKey, '+', '-', 'COUNT', 1);
    if (entries.length === 0) return 0;
    const [, fields] = entries[0];
    const dataIdx = fields.indexOf('data');
    const raw = dataIdx >= 0 ? fields[dataIdx + 1] : '{}';
    const event = JSON.parse(raw) as SequencedEvent;
    return event.seq;
  }

  async oldestSeq(): Promise<number> {
    const entries = await this.client.xrange(this.streamKey, '-', '+', 'COUNT', 1);
    if (entries.length === 0) return -1;
    const [, fields] = entries[0];
    const dataIdx = fields.indexOf('data');
    const raw = dataIdx >= 0 ? fields[dataIdx + 1] : '{}';
    const event = JSON.parse(raw) as SequencedEvent;
    return event.seq;
  }
}
