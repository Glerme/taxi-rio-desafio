import type { ConsumeMessage } from 'amqplib';
import type { CorridaEvent } from 'contracts';
import { CORRIDA_TTL_SECONDS, corridaKey } from 'contracts';
import type Redis from 'ioredis';
import { processMessage, StoredEvent } from './process-message';

const event: CorridaEvent = {
  event_id: 'evt-1',
  type: 'corrida.status_alterado',
  corrida_id: 'corrida-1',
  passageiro_id: 'passageiro-1',
  motorista_id: null,
  status: 'aceita',
  version: 2,
  occurred_at: '2026-11-09T12:00:00.000Z',
};

const msg = (value: unknown = event) => ({ content: Buffer.from(JSON.stringify(value)) }) as ConsumeMessage;

function deps() {
  return {
    channel: { ack: jest.fn(), nack: jest.fn() },
    collection: { insertOne: jest.fn().mockResolvedValue({ acknowledged: true }) },
    redis: { eval: jest.fn().mockResolvedValue(1) } as unknown as Redis & { eval: jest.Mock },
  };
}

// Snapshot written to the cache is the fifth eval argument (script, 1, key, version, payload, ttl).
function cachedSnapshot(redis: { eval: jest.Mock }): Record<string, unknown> {
  return JSON.parse(redis.eval.mock.calls[0][4] as string);
}

describe('processMessage', () => {
  it('persists the event, updates the cache snapshot and acks', async () => {
    const d = deps();

    await processMessage(msg(), d);

    expect(d.collection.insertOne).toHaveBeenCalledWith({ ...event, received_at: expect.any(Date) });
    expect(d.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      corridaKey(event.corrida_id),
      event.version,
      expect.any(String),
      CORRIDA_TTL_SECONDS,
    );
    expect(cachedSnapshot(d.redis)).toEqual({
      id: event.corrida_id,
      passageiro_id: event.passageiro_id,
      motorista_id: event.motorista_id,
      status: event.status,
      version: event.version,
      updated_at: event.occurred_at,
    });
    // Persist before caching so a Mongo outage never advances the cache.
    expect(d.collection.insertOne.mock.invocationCallOrder[0]).toBeLessThan(
      d.redis.eval.mock.invocationCallOrder[0],
    );
    expect(d.channel.ack).toHaveBeenCalledWith(msg());
    expect(d.channel.nack).not.toHaveBeenCalled();
  });

  it('treats duplicate inserts as success and still repairs the cache', async () => {
    const d = deps();
    d.collection.insertOne.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await processMessage(msg(), d);

    expect(d.channel.ack).toHaveBeenCalledTimes(1);
    expect(d.channel.nack).not.toHaveBeenCalled();
    expect(d.redis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, corridaKey(event.corrida_id), event.version, expect.any(String), CORRIDA_TTL_SECONDS,
    );
  });

  it('processes the same event twice with two acks, one stored document and one cache entry', async () => {
    const d = deps();
    const stored = new Map<string, StoredEvent>();
    d.collection.insertOne.mockImplementation(async (doc: StoredEvent) => {
      if (stored.has(doc.event_id)) throw Object.assign(new Error('E11000'), { code: 11000 });
      stored.set(doc.event_id, doc);
      return { acknowledged: true } as never;
    });
    // The version guard returns 1 on the first write and 0 once the same snapshot is cached.
    d.redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await processMessage(msg(), d);
    await processMessage(msg(), d);

    expect(d.channel.ack).toHaveBeenCalledTimes(2);
    expect(d.channel.nack).not.toHaveBeenCalled();
    expect(stored.size).toBe(1);
    expect(d.collection.insertOne).toHaveBeenCalledTimes(2);
    expect(cachedSnapshot(d.redis)).toEqual({
      id: event.corrida_id,
      passageiro_id: event.passageiro_id,
      motorista_id: event.motorista_id,
      status: event.status,
      version: event.version,
      updated_at: event.occurred_at,
    });
  });

  it.each([
    ['Mongo', Object.assign(new Error('mongo down'), { code: 500 })],
    ['Redis', new Error('redis down')],
  ])('requeues on %s failure without acking', async (source, error) => {
    const d = deps();
    if (source === 'Mongo') d.collection.insertOne.mockRejectedValueOnce(error);
    else d.redis.eval.mockRejectedValueOnce(error);

    await processMessage(msg(), d);

    expect(d.channel.nack).toHaveBeenCalledWith(msg(), false, true);
    expect(d.channel.ack).not.toHaveBeenCalled();
    if (source === 'Mongo') expect(d.redis.eval).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', Buffer.from('{oops')],
    ['missing corrida_id', Buffer.from(JSON.stringify({ ...event, corrida_id: undefined }))],
  ])('dead-letters malformed messages without touching storage: %s', async (_name, content) => {
    const d = deps();

    await processMessage({ content } as ConsumeMessage, d);

    expect(d.channel.nack).toHaveBeenCalledWith({ content }, false, false);
    expect(d.channel.ack).not.toHaveBeenCalled();
    expect(d.collection.insertOne).not.toHaveBeenCalled();
    expect(d.redis.eval).not.toHaveBeenCalled();
  });
});
