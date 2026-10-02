import { MemoryReplayStore } from './memory-replay.store';
import { RedisReplayStore } from './redis-replay.store';
import { SequencedEvent } from './replay-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(seq: number, type = 'intent_created'): SequencedEvent {
  return { seq, type };
}

// ─── MemoryReplayStore ────────────────────────────────────────────────────────

describe('MemoryReplayStore', () => {
  it('returns empty result when no events', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    const result = await store.since(0);
    expect(result.tooOld).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('since(0) returns all events', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    await store.append(makeEvent(1));
    await store.append(makeEvent(2));
    await store.append(makeEvent(3));

    const result = await store.since(0);
    expect(result.tooOld).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('since(n) returns events with seq > n', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    for (let i = 1; i <= 5; i++) await store.append(makeEvent(i));

    const result = await store.since(2);
    expect(result.tooOld).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('returns tooOld=true when fromSeq is older than retained history', async () => {
    const store = new MemoryReplayStore({ maxCount: 3 });
    // Fill beyond capacity — events 1 and 2 get evicted
    for (let i = 1; i <= 5; i++) await store.append(makeEvent(i));

    // Buffer now contains 3,4,5.  Requesting from seq=0 means fromSeq < oldest-1 → tooOld
    const result = await store.since(0);
    expect(result.tooOld).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('returns tooOld=false when buffer is empty', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    const result = await store.since(5);
    expect(result.tooOld).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('applies count-based eviction', async () => {
    const store = new MemoryReplayStore({ maxCount: 3 });
    for (let i = 1; i <= 5; i++) await store.append(makeEvent(i));

    expect(await store.oldestSeq()).toBe(3);
    expect(await store.latestSeq()).toBe(5);
  });

  it('applies age-based eviction', async () => {
    const store = new MemoryReplayStore({ maxCount: 100, maxAgeMs: 50 });
    await store.append(makeEvent(1));

    // Wait for the entry to age out
    await new Promise((r) => setTimeout(r, 80));
    await store.append(makeEvent(2)); // triggers age eviction

    expect(await store.oldestSeq()).toBe(2);
  });

  it('latestSeq() returns 0 when empty', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    expect(await store.latestSeq()).toBe(0);
  });

  it('latestSeq() returns highest seq when populated', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    await store.append(makeEvent(1));
    await store.append(makeEvent(5));
    await store.append(makeEvent(3));
    expect(await store.latestSeq()).toBe(3);
  });

  it('oldestSeq() returns -1 when empty', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    expect(await store.oldestSeq()).toBe(-1);
  });

  it('oldestSeq() returns lowest seq when populated', async () => {
    const store = new MemoryReplayStore({ maxCount: 10 });
    await store.append(makeEvent(5));
    await store.append(makeEvent(6));
    await store.append(makeEvent(7));
    expect(await store.oldestSeq()).toBe(5);
  });
});

// ─── RedisReplayStore ─────────────────────────────────────────────────────────

// Mock the ioredis module so RedisReplayStore tests never need a live Redis.
jest.mock('ioredis', () => {
  const stream: Array<[string, string[]]> = [];

  const mockClient = {
    xadd: jest.fn().mockImplementation(
      async (...args: unknown[]) => {
        // XADD key MAXLEN ~ count id data jsonStr
        const dataArgIdx = (args as string[]).indexOf('data');
        const id = dataArgIdx > 0 ? (args[dataArgIdx - 1] as string) : `0-${Date.now()}`;
        const value = dataArgIdx > 0 ? (args[dataArgIdx + 1] as string) : '{}';
        stream.push([id, ['data', value]]);
        return id;
      },
    ),
    xrange: jest.fn().mockImplementation(
      async (...args: unknown[]) => {
        // args: key, start, end [, 'COUNT', n]
        const start = args[1] as string;
        const countIdx = (args as string[]).indexOf('COUNT');
        const count = countIdx >= 0 ? Number(args[countIdx + 1]) : Infinity;

        let results = stream.filter(([id]) => {
          if (start === '-') return true;
          return id >= start;
        });
        if (isFinite(count)) results = results.slice(0, count);
        return results;
      },
    ),
    xrevrange: jest.fn().mockImplementation(
      async (...args: unknown[]) => {
        // args: key, end, start [, 'COUNT', n]
        const countIdx = (args as string[]).indexOf('COUNT');
        const count = countIdx >= 0 ? Number(args[countIdx + 1]) : Infinity;
        let results = [...stream].reverse();
        if (isFinite(count)) results = results.slice(0, count);
        return results;
      },
    ),
    xtrim: jest.fn().mockResolvedValue(0),
    _stream: stream,
    _clearStream: () => { stream.splice(0, stream.length); },
  };

  // With esModuleInterop=true, `import Redis from 'ioredis'` compiles to
  // `ioredis_1.default`, so we must expose the constructor as `default`.
  const MockRedis = jest.fn().mockReturnValue(mockClient);
  return {
    __esModule: true,
    default: MockRedis,
    __mockClient: mockClient,
  };
});

describe('RedisReplayStore', () => {
  let store: RedisReplayStore;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const redisMock = require('ioredis') as { __mockClient: { xadd: jest.Mock; xrange: jest.Mock; xrevrange: jest.Mock; xtrim: jest.Mock; _clearStream: () => void } };

  beforeEach(() => {
    jest.clearAllMocks();
    redisMock.__mockClient._clearStream();
    store = new RedisReplayStore({
      redisUrl: 'redis://localhost:6379',
      streamKey: 'test:replay',
      maxCount: 100,
    });
  });

  it('append calls xadd with correct entry ID and MAXLEN', async () => {
    await store.append(makeEvent(42));
    expect(redisMock.__mockClient.xadd).toHaveBeenCalledWith(
      'test:replay',
      'MAXLEN',
      '~',
      100,
      '0-42',
      'data',
      JSON.stringify(makeEvent(42)),
    );
  });

  it('since calls xrange with correct range start', async () => {
    await store.append(makeEvent(1));
    await store.append(makeEvent(2));
    await store.append(makeEvent(3));

    const result = await store.since(1);
    expect(result.tooOld).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('since(0) returns all events without tooOld', async () => {
    await store.append(makeEvent(1));
    await store.append(makeEvent(2));

    const result = await store.since(0);
    expect(result.tooOld).toBe(false);
    expect(result.events.length).toBe(2);
  });

  it('detects tooOld when stream has entries but none match fromSeq', async () => {
    await store.append(makeEvent(10));
    await store.append(makeEvent(11));

    // Requesting from seq 3 — stream starts at 10, so there's a gap
    const result = await store.since(3);
    expect(result.tooOld).toBe(true);
  });

  it('latestSeq uses xrevrange COUNT 1', async () => {
    await store.append(makeEvent(5));
    await store.append(makeEvent(8));

    const seq = await store.latestSeq();
    expect(redisMock.__mockClient.xrevrange).toHaveBeenCalledWith('test:replay', '+', '-', 'COUNT', 1);
    expect(seq).toBe(8);
  });

  it('latestSeq returns 0 when stream is empty', async () => {
    const seq = await store.latestSeq();
    expect(seq).toBe(0);
  });

  it('oldestSeq uses xrange COUNT 1', async () => {
    await store.append(makeEvent(3));
    await store.append(makeEvent(4));

    const seq = await store.oldestSeq();
    expect(redisMock.__mockClient.xrange).toHaveBeenCalledWith('test:replay', '-', '+', 'COUNT', 1);
    expect(seq).toBe(3);
  });

  it('oldestSeq returns -1 when stream is empty', async () => {
    const seq = await store.oldestSeq();
    expect(seq).toBe(-1);
  });

  it('handles redis errors by throwing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const ioreids = require('ioredis') as { default: jest.Mock };
    ioreids.default.mockImplementationOnce(() => ({
      xadd: jest.fn().mockRejectedValue(new Error('Connection refused')),
    }));

    const failingStore = new RedisReplayStore({
      redisUrl: 'redis://bad-host',
      streamKey: 'test',
      maxCount: 10,
    });

    await expect(failingStore.append(makeEvent(1))).rejects.toThrow();
  });
});

// ─── Ordering and resume ──────────────────────────────────────────────────────

describe('Ordering and resume', () => {
  it('MemoryReplayStore returns events in seq order', async () => {
    const store = new MemoryReplayStore({ maxCount: 100 });
    // Append in order
    for (let i = 1; i <= 10; i++) await store.append(makeEvent(i));

    const result = await store.since(0);
    const seqs = result.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('since() after simulated restart / state load', async () => {
    const store = new MemoryReplayStore({ maxCount: 100 });
    for (let i = 1; i <= 20; i++) await store.append(makeEvent(i));

    // Simulate a client that last saw seq 15 and reconnects
    const result = await store.since(15);
    expect(result.tooOld).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20]);
  });
});

// ─── Performance ─────────────────────────────────────────────────────────────

describe('Performance', () => {
  it('replays 10k events in under 1000ms (MemoryReplayStore)', async () => {
    const store = new MemoryReplayStore({ maxCount: 15_000 });

    // Populate 10k events
    for (let i = 1; i <= 10_000; i++) {
      await store.append({ seq: i, type: 'intent_created', data: `payload-${i}` });
    }

    const start = Date.now();
    const result = await store.since(0);
    const elapsed = Date.now() - start;

    expect(result.events.length).toBe(10_000);
    expect(elapsed).toBeLessThan(1000);
  });
});
