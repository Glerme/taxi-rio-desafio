import type { Channel } from 'amqplib';
import type Redis from 'ioredis';
import {
  assertTopology,
  canTransition,
  CorridaStatus,
  DLQ,
  DLX,
  EXCHANGE,
  publishOptions,
  setCorridaIfNewer,
  WORKER_QUEUE,
} from './index';

const STATUSES: CorridaStatus[] = ['solicitada', 'aceita', 'em_andamento', 'finalizada'];

describe('canTransition', () => {
  it('allows exactly one step forward through the happy path', () => {
    expect(canTransition('solicitada', 'aceita')).toBe(true);
    expect(canTransition('aceita', 'em_andamento')).toBe(true);
    expect(canTransition('em_andamento', 'finalizada')).toBe(true);
  });

  it('rejects skipping a step', () => {
    expect(canTransition('solicitada', 'em_andamento')).toBe(false);
    expect(canTransition('solicitada', 'finalizada')).toBe(false);
    expect(canTransition('aceita', 'finalizada')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransition('aceita', 'solicitada')).toBe(false);
    expect(canTransition('em_andamento', 'aceita')).toBe(false);
    expect(canTransition('finalizada', 'em_andamento')).toBe(false);
  });

  it('rejects staying on the same status', () => {
    for (const status of STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it('rejects every transition out of finalizada', () => {
    for (const status of STATUSES) expect(canTransition('finalizada', status)).toBe(false);
  });

  it('matches the full 4x4 matrix', () => {
    for (const [fromIndex, from] of STATUSES.entries()) {
      for (const [toIndex, to] of STATUSES.entries()) {
        expect([from, to, canTransition(from, to)]).toEqual([from, to, toIndex === fromIndex + 1]);
      }
    }
  });
});

describe('assertTopology', () => {
  const channelOf = () => ({
    assertExchange: jest.fn().mockResolvedValue({}),
    assertQueue: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
  });

  it('declares the topic exchange, DLX, DLQ and worker queue with bindings', async () => {
    const channel = channelOf();
    await assertTopology(channel as unknown as Channel);

    expect(channel.assertExchange).toHaveBeenCalledWith(EXCHANGE, 'topic', { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith(DLX, 'fanout', { durable: true });

    expect(channel.assertQueue).toHaveBeenCalledWith(DLQ, { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(WORKER_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': DLX,
      },
    });

    expect(channel.bindQueue).toHaveBeenCalledWith(DLQ, DLX, '');
    expect(channel.bindQueue).toHaveBeenCalledWith(WORKER_QUEUE, EXCHANGE, 'corrida.*');
  });

  it('uses the documented broker names', async () => {
    const channel = channelOf();
    await assertTopology(channel as unknown as Channel);

    expect(EXCHANGE).toBe('corridas');
    expect(WORKER_QUEUE).toBe('corridas.worker');
    expect(DLX).toBe('corridas.dlx');
    expect(DLQ).toBe('corridas.worker.dlq');
  });

  it('propagates a broker failure', async () => {
    const channel = channelOf();
    channel.assertExchange.mockRejectedValueOnce(new Error('broker down'));
    await expect(assertTopology(channel as unknown as Channel)).rejects.toThrow('broker down');
  });
});

describe('setCorridaIfNewer', () => {
  const corrida = { id: 'ride-1', version: 2, status: 'aceita' };
  const redisOf = (result: unknown) => ({ eval: jest.fn().mockResolvedValue(result) });

  it('runs the version-guarded Lua script with key, version, payload and TTL', async () => {
    const redis = redisOf(1);
    await setCorridaIfNewer(redis as unknown as Redis, corrida);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, version, payload, ttl] = redis.eval.mock.calls[0];
    expect(numKeys).toBe(1);
    expect(key).toBe('corrida:ride-1');
    expect(version).toBe(2);
    expect(payload).toBe(JSON.stringify(corrida));
    expect(ttl).toBe(3600);
    // The script must compare the stored version and write atomically under Redis' single-threaded eval.
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(script).toContain('>= tonumber(ARGV[1])');
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])");
  });

  it('returns true when the script writes and false when the guard rejects', async () => {
    await expect(setCorridaIfNewer(redisOf(1) as unknown as Redis, corrida)).resolves.toBe(true);
    await expect(setCorridaIfNewer(redisOf(0) as unknown as Redis, corrida)).resolves.toBe(false);
  });

  it('rejects a version that is not a positive safe integer without touching Redis', async () => {
    for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const redis = redisOf(1);
      await expect(
        setCorridaIfNewer(redis as unknown as Redis, { id: 'ride-1', version }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(redis.eval).not.toHaveBeenCalled();
    }
  });

  it('propagates a Redis failure', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('Redis unavailable')) };
    await expect(setCorridaIfNewer(redis as unknown as Redis, corrida)).rejects.toThrow(
      'Redis unavailable',
    );
  });
});

describe('publishOptions', () => {
  it('marks messages persistent and uses the event id as messageId', () => {
    const event = {
      event_id: 'event-1',
      type: 'corrida.criada' as const,
      corrida_id: 'ride-1',
      passageiro_id: 'pass-1',
      motorista_id: null,
      status: 'solicitada' as const,
      version: 1,
      occurred_at: '2026-11-09T12:00:00.000Z',
    };

    expect(publishOptions(event)).toEqual({ persistent: true, messageId: 'event-1' });
  });
});
