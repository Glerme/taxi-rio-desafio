import { SpanStatusCode } from '@opentelemetry/api';
import { logger } from './logger';
import { eventLag, messagesTotal, processingDuration } from './metrics';
import { withMessageSpan } from './message-tracing';
import type { Channel, ConsumeMessage } from 'amqplib';
import { CorridaEvent, ROUTING_KEYS, setCorridaIfNewer } from 'contracts';
import type Redis from 'ioredis';
import type { Collection } from 'mongodb';

export type StoredEvent = CorridaEvent & { received_at: Date };
export interface MessageDependencies {
  channel: Pick<Channel, 'ack' | 'nack'>;
  collection: Pick<Collection<StoredEvent>, 'insertOne'>;
  redis: Redis;
}

export function parseEvent(content: Buffer): CorridaEvent {
  const value: unknown = JSON.parse(content.toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('Event must be an object');
  const event = value as Record<string, unknown>;
  for (const field of ['event_id', 'corrida_id', 'passageiro_id', 'occurred_at']) {
    if (typeof event[field] !== 'string' || !event[field].trim()) {
      throw new Error(`Invalid ${field}`);
    }
  }
  if (
    !Object.values(ROUTING_KEYS).includes(event.type as CorridaEvent['type']) ||
    !['solicitada', 'aceita', 'em_andamento', 'finalizada'].includes(event.status as string) ||
    !(event.motorista_id === null || (typeof event.motorista_id === 'string' && event.motorista_id.trim())) ||
    !Number.isSafeInteger(event.version) || (event.version as number) < 1 ||
    !Number.isFinite(Date.parse(event.occurred_at as string))
  ) throw new Error('Invalid event fields');

  // Select contract fields so untrusted Mongo fields such as _id cannot be inserted.
  return {
    event_id: event.event_id as string,
    type: event.type as CorridaEvent['type'],
    corrida_id: event.corrida_id as string,
    passageiro_id: event.passageiro_id as string,
    motorista_id: event.motorista_id as string | null,
    status: event.status as CorridaEvent['status'],
    version: event.version as number,
    occurred_at: event.occurred_at as string,
  };
}

export async function processMessage(msg: ConsumeMessage, deps: MessageDependencies): Promise<void> {
  const stopTimer = processingDuration.startTimer();
  return withMessageSpan(msg, async (span) => {
    let outcome: 'processed' | 'duplicate' | 'malformed' | 'failed' = 'failed';
    let event: CorridaEvent | undefined;
    try {
      try {
        event = parseEvent(msg.content);
        span.setAttributes({ event_id: event.event_id, corrida_id: event.corrida_id, type: event.type });
      } catch (error) {
        outcome = 'malformed';
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.warn({ err: error, event_id: null, corrida_id: null, type: null, outcome }, 'Malformed event');
        deps.channel.nack(msg, false, false);
        return;
      }

      try {
        outcome = 'processed';
        try {
          await deps.collection.insertOne({ ...event, received_at: new Date() });
        } catch (error) {
          // event_id is the only caller-supplied unique key; duplicates still repair the cache.
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 11000) throw error;
          outcome = 'duplicate';
        }
        await setCorridaIfNewer(deps.redis, {
          id: event.corrida_id,
          passageiro_id: event.passageiro_id,
          motorista_id: event.motorista_id,
          status: event.status,
          version: event.version,
          updated_at: event.occurred_at,
        });
        deps.channel.ack(msg);
        eventLag.observe(Math.max(0, (Date.now() - Date.parse(event.occurred_at)) / 1000));
      } catch (error) {
        outcome = 'failed';
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.error({ err: error, event_id: event.event_id, corrida_id: event.corrida_id, type: event.type, outcome }, 'Event processing failed');
        deps.channel.nack(msg, false, true);
      }
    } finally {
      span.setAttribute('outcome', outcome);
      messagesTotal.inc({ outcome });
      stopTimer();
      if (event && (outcome === 'processed' || outcome === 'duplicate')) {
        logger.info({ event_id: event.event_id, corrida_id: event.corrida_id, type: event.type, outcome }, 'Event processed');
      }
    }
  });
}
