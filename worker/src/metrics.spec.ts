import type { ConsumeMessage } from 'amqplib';
import type { CorridaEvent } from 'contracts';
import type Redis from 'ioredis';
import { registry } from './metrics';
import { processMessage } from './process-message';

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

async function metricValues(name: string): Promise<Array<{
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}>> {
  const values = (await registry.getMetricsAsJSON()).find((metric) => metric.name === name)?.values ?? [];
  return values as Array<{ value: number; labels: Record<string, string | number>; metricName?: string }>;
}

async function outcomeCount(outcome: string): Promise<number> {
  const values = await metricValues('worker_messages_total');
  return values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

async function histogramCount(name: string): Promise<number> {
  const values = await metricValues(name);
  return values.find((value) => value.metricName === `${name}_count`)?.value ?? 0;
}

describe('worker metrics', () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it('counts a processed message and records its event lag', async () => {
    const d = deps();

    await processMessage(msg(), d);

    expect(await outcomeCount('processed')).toBe(1);
    expect(await histogramCount('worker_processing_duration_seconds')).toBe(1);
    expect(await histogramCount('worker_event_lag_seconds')).toBe(1);
  });

  it('counts a duplicate insert as duplicate', async () => {
    const d = deps();
    d.collection.insertOne.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await processMessage(msg(), d);

    expect(await outcomeCount('duplicate')).toBe(1);
    expect(await outcomeCount('processed')).toBe(0);
    expect(await histogramCount('worker_event_lag_seconds')).toBe(1);
  });

  it('counts a malformed message as malformed without event lag', async () => {
    const d = deps();

    await processMessage({ content: Buffer.from('{oops') } as ConsumeMessage, d);

    expect(await outcomeCount('malformed')).toBe(1);
    expect(await histogramCount('worker_processing_duration_seconds')).toBe(1);
    expect(await histogramCount('worker_event_lag_seconds')).toBe(0);
  });

  it.each([
    ['Mongo', Object.assign(new Error('mongo down'), { code: 500 })],
    ['Redis', new Error('redis down')],
  ])('counts a %s failure as failed without event lag', async (source, error) => {
    const d = deps();
    if (source === 'Mongo') d.collection.insertOne.mockRejectedValueOnce(error);
    else d.redis.eval.mockRejectedValueOnce(error);

    await processMessage(msg(), d);

    expect(await outcomeCount('failed')).toBe(1);
    expect(await histogramCount('worker_processing_duration_seconds')).toBe(1);
    expect(await histogramCount('worker_event_lag_seconds')).toBe(0);
  });
});
