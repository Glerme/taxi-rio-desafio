import './tracing';
import 'reflect-metadata';
import { Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Channel, ChannelModel, connect } from 'amqplib';
import { assertTopology, EVENTOS_COLLECTION, EVENTOS_UNIQUE_INDEX, WORKER_QUEUE } from 'contracts';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { processMessage, StoredEvent } from './process-message';
import { logger } from './logger';
import { startMetricsServer } from './metrics';
import { shutdownTracing } from './tracing';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

@Injectable()
class Worker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = logger;
  private mongo?: MongoClient;
  private redis?: Redis;
  private connection?: ChannelModel;
  private channel?: Channel;
  private consumerTag?: string;
  private stopping = false;
  private readonly pending = new Set<Promise<void>>();

  async onModuleInit(): Promise<void> {
    try {
      this.mongo = new MongoClient(requiredEnv('MONGO_URL'));
      await this.mongo.connect();
      const collection = this.mongo.db().collection<StoredEvent>(EVENTOS_COLLECTION);
      await collection.createIndex(EVENTOS_UNIQUE_INDEX.key, { unique: EVENTOS_UNIQUE_INDEX.unique });
      this.redis = new Redis(requiredEnv('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.redis.on('error', (error: Error) => this.logger.error(error.message));
      await this.redis.connect();
      this.connection = await connect(requiredEnv('RABBITMQ_URL'));
      this.connection.on('error', (error: Error) => this.logger.error(error.message));
      this.connection.on('close', () => {
        if (!this.stopping) {
          this.logger.error('AMQP connection closed; exiting for restart');
          process.exit(1);
        }
      });
      const channel = this.channel = await this.connection.createChannel();
      channel.on('error', (error: Error) => this.logger.error(error.message));
      channel.on('close', () => {
        if (!this.stopping) process.exit(1);
      });
      await assertTopology(channel);
      await channel.prefetch(10);
      const redis = this.redis;
      const consumer = await channel.consume(WORKER_QUEUE, (msg) => {
        if (!msg) {
          if (!this.stopping) process.exit(1);
          return;
        }
        const task = processMessage(msg, { channel, collection, redis });
        this.pending.add(task);
        void task.catch((error: unknown) => {
          this.logger.error(`Cannot settle message: ${String(error)}`);
          process.exit(1);
        }).finally(() => this.pending.delete(task));
      }, { noAck: false });
      this.consumerTag = consumer.consumerTag;
      this.logger.info(`Consuming ${WORKER_QUEUE}`);
    } catch (error) {
      await this.onModuleDestroy();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    try {
      if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
      await Promise.allSettled(this.pending);
    } finally {
      const results = await Promise.allSettled([
        this.channel?.close(), this.connection?.close(), this.mongo?.close(),
      ]);
      this.redis?.disconnect();
      metricsServer.close();
      await shutdownTracing();
      for (const result of results) {
        if (result.status === 'rejected') this.logger.error(String(result.reason));
      }
    }
  }
}

@Module({ providers: [Worker] })
class WorkerModule {}

const metricsServer = startMetricsServer();
metricsServer.on('error', (error) => {
  logger.error({ err: error }, 'Metrics server failed');
  process.exit(1);
});

void NestFactory.createApplicationContext(WorkerModule, { logger: false }).then((app) => {
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}).catch((error: unknown) => {
  logger.error({ err: error }, 'Worker startup failed');
  process.exit(1);
});
