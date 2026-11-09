import { context, trace } from '@opentelemetry/api';
import pino from 'pino';

export const logger = pino({
  mixin() {
    const span = trace.getSpan(context.active())?.spanContext();
    // trace_id is the correlation_id across the HTTP request and worker delivery.
    return { trace_id: span?.traceId ?? null, span_id: span?.spanId ?? null };
  },
});
