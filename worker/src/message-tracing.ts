import { context, propagation, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ConsumeMessage } from 'amqplib';
import { WORKER_QUEUE } from 'contracts';

export function withMessageSpan<T>(msg: ConsumeMessage, run: (span: Span) => Promise<T>): Promise<T> {
  const parent = propagation.extract(ROOT_CONTEXT, msg.properties?.headers ?? {});
  const span = trace.getTracer('worker').startSpan('corridas process', {
    kind: SpanKind.CONSUMER,
    attributes: {
      'messaging.system': 'rabbitmq',
      'messaging.destination': WORKER_QUEUE,
      'messaging.rabbitmq.destination.routing_key': msg.fields?.routingKey ?? '',
    },
  }, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await run(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
