import type { DataSource } from 'typeorm';
import { connect } from 'amqplib';
import type { CorridaEvent } from 'contracts';
import { EXCHANGE, publishOptions, ROUTING_KEYS } from 'contracts';
import { Outbox } from '../src/entities';
import { OutboxRelay } from '../src/infrastructure';
import { FakeDataSource } from './support';

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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not met');
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

const eventOf = (id: string, routingKey: CorridaEvent['type'], occurredAt: string): CorridaEvent => ({
  event_id: id, type: routingKey, corrida_id: '11111111-1111-4111-8111-111111111111',
  passageiro_id: 'p1', motorista_id: null, status: 'solicitada', version: 1, occurred_at: occurredAt,
});

function seedEvent(db: FakeDataSource, id: string, routingKey: CorridaEvent['type'], occurredAt: string): CorridaEvent {
  const payload = eventOf(id, routingKey, occurredAt);
  db.seed(Outbox, { event_id: id, routing_key: routingKey, payload, created_at: new Date(occurredAt), sent_at: null });
  return payload;
}

const sentAtOf = (db: FakeDataSource): unknown[] => db.rows(Outbox).map((row) => row.sent_at);

describe('OutboxRelay.tick', () => {
  it('publishes each pending row with persistent options and marks sent_at only after confirms', async () => {
    const db = new FakeDataSource();
    const first = seedEvent(db, 'evt-1', ROUTING_KEYS.CRIADA, '2026-01-01T00:00:00.000Z');
    const second = seedEvent(db, 'evt-2', ROUTING_KEYS.STATUS_ALTERADO, '2026-01-01T00:00:01.000Z');
    const { channel } = broker();
    let confirm!: () => void;
    channel.waitForConfirms.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
    const relay = new OutboxRelay(db as unknown as DataSource);

    const ticking = relay.tick();
    await until(() => channel.publish.mock.calls.length === 2);

    const [exchange1, routing1, body1, options1] = channel.publish.mock.calls[0];
    expect(exchange1).toBe(EXCHANGE);
    expect(routing1).toBe(ROUTING_KEYS.CRIADA);
    expect((body1 as Buffer).toString()).toBe(JSON.stringify(first));
    expect(options1).toEqual(publishOptions(first));

    const [exchange2, routing2, body2, options2] = channel.publish.mock.calls[1];
    expect(exchange2).toBe(EXCHANGE);
    expect(routing2).toBe(ROUTING_KEYS.STATUS_ALTERADO);
    expect((body2 as Buffer).toString()).toBe(JSON.stringify(second));
    expect(options2).toEqual({ persistent: true, messageId: 'evt-2' });

    // The broker has not confirmed yet: nothing may be flagged as sent.
    expect(sentAtOf(db)).toEqual([null, null]);

    confirm();
    await ticking;

    expect(sentAtOf(db).map((value) => value instanceof Date)).toEqual([true, true]);

    // Sent rows are not published again on the next cycle.
    await relay.tick();
    expect(channel.publish).toHaveBeenCalledTimes(2);
  });

  it('does not mark sent_at when publish throws', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1', ROUTING_KEYS.CRIADA, '2026-01-01T00:00:00.000Z');
    const { channel } = broker();
    channel.publish.mockImplementation(() => { throw new Error('broker refused'); });
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    expect(sentAtOf(db)).toEqual([null]);
  });

  it('does not mark sent_at when the broker never confirms', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1', ROUTING_KEYS.CRIADA, '2026-01-01T00:00:00.000Z');
    const { channel } = broker();
    channel.waitForConfirms.mockRejectedValue(new Error('nack'));
    const relay = new OutboxRelay(db as unknown as DataSource);

    await relay.tick();

    expect(sentAtOf(db)).toEqual([null]);
  });

  it('does not run overlapping cycles when tick() is called concurrently', async () => {
    const db = new FakeDataSource();
    seedEvent(db, 'evt-1', ROUTING_KEYS.CRIADA, '2026-01-01T00:00:00.000Z');
    const { channel } = broker();
    let confirm!: () => void;
    channel.waitForConfirms.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
    const relay = new OutboxRelay(db as unknown as DataSource);

    const first = relay.tick();
    const second = relay.tick();
    await until(() => channel.publish.mock.calls.length === 1);
    await flush();
    expect(channel.publish).toHaveBeenCalledTimes(1);

    confirm();
    await Promise.all([first, second]);

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(sentAtOf(db)[0]).toBeInstanceOf(Date);
  });
});
