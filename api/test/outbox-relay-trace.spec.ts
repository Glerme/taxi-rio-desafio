import type { DataSource } from 'typeorm';
import { SpanKind } from '@opentelemetry/api';
import { connect } from 'amqplib';
import type { CorridaEvent } from 'contracts';
import { EXCHANGE, ROUTING_KEYS } from 'contracts';
import { Outbox } from '../src/entities';
import { OutboxRelay } from '../src/infrastructure';
import { metrics, outboxErrors, outboxOldestAge, outboxPending, outboxPublished } from '../src/observability';
import { FakeDataSource } from './support';
import { parseTraceparent, requestSpan, startTestTracing, traceparentOf, type RecordedSpan } from './trace-support';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

const connectMock = connect as unknown as jest.Mock;

type ChannelMock = {
  publish: jest.Mock;
  waitForConfirms: jest.Mock;
  assertExchange: jest.Mock;
  assertQueue: jest.Mock;
  bindQueue: jest.Mock;
  on: jest.Mock;
};

function broker(): { channel: ChannelMock } {
  const channel: ChannelMock = {
    publish: jest.fn(),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    assertExchange: jest.fn().mockResolvedValue({}),
    assertQueue: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
    on: jest.fn(),
  };
  connectMock.mockResolvedValue({
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  });
  return { channel };
}

const eventOf = (id: string): CorridaEvent => ({
  event_id: id, type: ROUTING_KEYS.CRIADA, corrida_id: '11111111-1111-4111-8111-111111111111',
  passageiro_id: 'p1', motorista_id: null, status: 'solicitada', version: 1, occurred_at: '2026-01-01T00:00:00.000Z',
});

function seedEvent(db: FakeDataSource, id: string, traceparent?: string): CorridaEvent {
  const payload = eventOf(id);
  db.seed(Outbox, {
    event_id: id, routing_key: ROUTING_KEYS.CRIADA, payload, created_at: new Date(payload.occurred_at), sent_at: null,
    traceparent: traceparent ?? null, tracestate: null,
  });
  return payload;
}

const metricValue = async (metric: unknown): Promise<number> => {
  const { values } = await (metric as { get(): Promise<{ values: { value: number }[] }> }).get();
  return values[0]?.value ?? 0;
};

describe('OutboxRelay observability', () => {
  let tracing: { sdk: { shutdown(): Promise<void> }; spans: RecordedSpan[] };

  beforeAll(() => { tracing = startTestTracing(); });

  afterAll(async () => { await tracing.sdk.shutdown(); });

  beforeEach(() => {
    tracing.spans.length = 0;
    outboxPublished.reset();
    outboxErrors.reset();
    outboxPending.reset();
    outboxOldestAge.reset();
  });

  it('publishes the outbox row as a child of the stored trace and keeps the trace_id in AMQP headers', async () => {
    const db = new FakeDataSource();
    const parent = requestSpan('POST /corridas');
    const parentContext = parent.spanContext();
    seedEvent(db, 'evt-1', traceparentOf(parentContext));
    const { channel } = broker();
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    const [, , , options] = channel.publish.mock.calls[0];
    const published = parseTraceparent(options.headers?.traceparent);
    expect(published).not.toBeNull();
    expect(published?.traceId).toBe(parentContext.traceId);
    expect(published?.spanId).not.toBe(parentContext.spanId);
    expect(options).toMatchObject({ persistent: true, messageId: 'evt-1' });

    const producer = tracing.spans.find((span) => span.name === 'corridas publish');
    expect(producer).toMatchObject({
      kind: SpanKind.PRODUCER,
      traceId: parentContext.traceId,
      parentSpanId: parentContext.spanId,
      spanId: published?.spanId,
    });
    expect(producer?.attributes).toMatchObject({
      'messaging.system': 'rabbitmq',
      'messaging.destination': EXCHANGE,
      'messaging.rabbitmq.routing_key': ROUTING_KEYS.CRIADA,
      event_id: 'evt-1',
      corrida_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(db.rows(Outbox)[0].sent_at).toBeInstanceOf(Date);
  });

  it('publishes a row without traceparent under a fresh trace without breaking', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1');
    const { channel } = broker();
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [, , , options] = channel.publish.mock.calls[0];
    const published = parseTraceparent(options.headers?.traceparent);
    expect(published).not.toBeNull();
    const producer = tracing.spans.find((span) => span.name === 'corridas publish');
    expect(producer).toMatchObject({ traceId: published?.traceId, spanId: published?.spanId });
    expect(producer?.parentSpanId).toBeUndefined();
    expect(db.rows(Outbox)[0].sent_at).toBeInstanceOf(Date);
  });

  it('counts published rows and clears the pending gauges after a successful tick', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1');
    seedEvent(db, 'evt-2');
    broker();
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    expect(await metricValue(outboxPublished)).toBe(2);
    expect(await metricValue(outboxErrors)).toBe(0);
    expect(await metricValue(outboxPending)).toBe(0);
    expect(await metricValue(outboxOldestAge)).toBe(0);
  });

  it('keeps the pending rows and their age when publication fails, counting the error', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1');
    seedEvent(db, 'evt-2');
    const { channel } = broker();
    channel.publish.mockImplementation(() => { throw new Error('broker refused'); });
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    expect(await metricValue(outboxPublished)).toBe(0);
    expect(await metricValue(outboxErrors)).toBe(1);
    expect(await metricValue(outboxPending)).toBe(2);
    expect(await metricValue(outboxOldestAge)).toBeGreaterThan(0);
    expect(db.rows(Outbox).map((row) => row.sent_at)).toEqual([null, null]);
  });

  it('registers the outbox metrics under their fixed names', async () => {
    const names = (await metrics.getMetricsAsJSON()).map((metric) => metric.name);
    expect(names).toEqual(expect.arrayContaining([
      'outbox_pending',
      'outbox_oldest_pending_age_seconds',
      'outbox_published_total',
      'outbox_publish_errors_total',
    ]));
  });
});
