import { propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ConsumeMessage } from 'amqplib';
import { withMessageSpan } from './message-tracing';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';

function msg(headers?: Record<string, string>): ConsumeMessage {
  return {
    content: Buffer.from('{}'),
    fields: { routingKey: 'corrida.status_alterado' },
    properties: headers ? { headers } : {},
  } as unknown as ConsumeMessage;
}

describe('withMessageSpan', () => {
  let exporter: any;
  let provider: any;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterEach(async () => {
    trace.disable();
    propagation.disable();
    await provider.shutdown();
  });

  it('continues the trace from a valid W3C traceparent header', async () => {
    let childSpanId = '';

    await withMessageSpan(msg({ traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01` }), async (span) => {
      childSpanId = span.spanContext().spanId;
    });

    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(childSpanId).not.toBe(PARENT_SPAN_ID);
    expect(span.parentSpanContext).toMatchObject({ traceId: TRACE_ID, spanId: PARENT_SPAN_ID });
    expect(span.kind).toBe(SpanKind.CONSUMER);
  });

  it('starts a new trace without headers and without failing', async () => {
    await expect(withMessageSpan(msg(), async () => undefined)).resolves.toBeUndefined();

    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('marks the span as ERROR and rethrows when processing fails', async () => {
    await expect(
      withMessageSpan(msg(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event: { name: string }) => event.name === 'exception')).toBe(true);
  });
});
