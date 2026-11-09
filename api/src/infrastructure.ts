import { context, propagation, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import Redis from 'ioredis';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';
import { assertTopology, EXCHANGE, publishOptions } from 'contracts';
import { Outbox } from './entities';
import { logger, outboxPending, outboxOldestAge, outboxPublished, outboxErrors } from './observability';

@Injectable()
export class CacheService implements OnModuleDestroy {
  readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  private readonly logger = new Logger(CacheService.name);
  constructor() {
    this.redis.on('error', (error: Error) => this.logger.warn(error.message));
  }
  onModuleDestroy(): void { this.redis.disconnect(); }
}

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  constructor(private readonly db: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 500);
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.connection) {
      await this.connection.close().catch(() => undefined);
      this.connection = undefined;
    }
    const connection = await connect(process.env.RABBITMQ_URL ?? 'amqp://localhost', { timeout: 5000 });
    this.connection = connection;
    connection.on('error', (error: Error) => this.logger.warn(error.message));
    connection.on('close', () => {
      if (this.connection === connection) { this.channel = undefined; this.connection = undefined; }
    });
    const channel = await connection.createConfirmChannel();
    channel.on('error', (error: Error) => this.logger.warn(error.message));
    channel.on('close', () => { if (this.channel === channel) this.channel = undefined; });
    await assertTopology(channel);
    this.channel = channel;
    return channel;
  }

  async tick(): Promise<void> {
    await context.with(suppressTracing(ROOT_CONTEXT), async () => {
      if (this.running || this.stopped) return;
      this.running = true;
      const spans: { span: Span; entry: Outbox }[] = [];
      let published = 0;
      try {
        const channel = await this.getChannel();
        await this.db.transaction(async manager => {
          const events = await manager.getRepository(Outbox).createQueryBuilder('outbox')
            .where({ sent_at: IsNull() }).orderBy('outbox.created_at', 'ASC').take(50)
            .setLock('pessimistic_write').setOnLocked('skip_locked').getMany();
          for (const entry of events) {
            const carrier = { traceparent: entry.traceparent ?? '', tracestate: entry.tracestate ?? '' };
            const parent = propagation.extract(ROOT_CONTEXT, carrier);
            trace.getTracer('api').startActiveSpan('corridas publish', {
              kind: SpanKind.PRODUCER,
              attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination': EXCHANGE, 'messaging.rabbitmq.routing_key': entry.routing_key, event_id: entry.event_id, corrida_id: entry.payload.corrida_id },
            }, parent, span => {
              spans.push({ span, entry });
              const headers: Record<string, string> = {};
              propagation.inject(context.active(), headers);
              const options = publishOptions(entry.payload);
              channel.publish(EXCHANGE, entry.routing_key, Buffer.from(JSON.stringify(entry.payload)), {
                ...options, ...(Object.keys(headers).length ? { headers: { ...options.headers, ...headers } } : {}),
              });
              logger.info({ event_id: entry.event_id, corrida_id: entry.payload.corrida_id }, 'Outbox publication queued for confirmation');
            });
          }
          await channel.waitForConfirms();
          for (const entry of events) await manager.update(Outbox, { event_id: entry.event_id }, { sent_at: new Date() });
          published = events.length;
        });
        outboxPublished.inc(published);
      } catch (error) {
        outboxErrors.inc();
        for (const { span, entry } of spans) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
            logger.warn({ event_id: entry.event_id, corrida_id: entry.payload.corrida_id, err: error }, 'Outbox publication will retry');
          });
        }
        this.logger.warn(`Outbox will retry: ${error instanceof Error ? error.message : String(error)}`);
        const connection = this.connection;
        this.connection = undefined;
        this.channel = undefined;
        if (connection) await connection.close().catch(() => undefined);
      } finally {
        for (const { span } of spans) span.end();
        try {
          const pending = await this.db.getRepository(Outbox).createQueryBuilder('outbox')
            .select('COUNT(*)', 'count').addSelect('MIN(outbox.created_at)', 'oldest')
            .where({ sent_at: IsNull() }).getRawOne<{ count: string; oldest: Date | string | null }>();
          outboxPending.set(Number(pending?.count ?? 0));
          outboxOldestAge.set(pending?.oldest ? Math.max(0, (Date.now() - new Date(pending.oldest).getTime()) / 1000) : 0);
        } catch (error) {
          this.logger.warn(`Outbox metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.running = false;
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.connection) await this.connection.close().catch(() => undefined);
  }
}
