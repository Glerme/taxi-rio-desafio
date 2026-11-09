import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import Redis from 'ioredis';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';
import { assertTopology, EXCHANGE, publishOptions } from 'contracts';
import { Outbox } from './entities';

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
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const channel = await this.getChannel();
      await this.db.transaction(async manager => {
        const events = await manager.getRepository(Outbox).createQueryBuilder('outbox')
          .where({ sent_at: IsNull() }).orderBy('outbox.created_at', 'ASC').take(50)
          .setLock('pessimistic_write').setOnLocked('skip_locked').getMany();
        for (const entry of events) {
          channel.publish(EXCHANGE, entry.routing_key, Buffer.from(JSON.stringify(entry.payload)), publishOptions(entry.payload));
        }
        await channel.waitForConfirms();
        for (const entry of events) await manager.update(Outbox, { event_id: entry.event_id }, { sent_at: new Date() });
      });
    } catch (error) {
      this.logger.warn(`Outbox will retry: ${error instanceof Error ? error.message : String(error)}`);
      const connection = this.connection;
      this.connection = undefined;
      this.channel = undefined;
      if (connection) await connection.close().catch(() => undefined);
    } finally { this.running = false; }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.connection) await this.connection.close().catch(() => undefined);
  }
}
