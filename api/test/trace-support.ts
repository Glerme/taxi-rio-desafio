import { context, SpanKind, TraceFlags, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

export type RecordedSpan = {
  name: string;
  kind: SpanKind;
  attributes: Record<string, unknown>;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

// Starts the real SDK already installed as an api dependency: async context manager,
// W3C propagator and in-memory span processor. No network exporter is configured.
export function startTestTracing(): { sdk: NodeSDK; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const sdk = new NodeSDK({
    serviceName: 'api-test',
    autoDetectResources: false,
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [],
    spanProcessors: [{
      onStart: () => undefined,
      onEnd: (span: any) => spans.push({
        name: span.name,
        kind: span.kind,
        attributes: span.attributes as Record<string, unknown>,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
      }),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    }],
  });
  sdk.start();
  return { sdk, spans };
}

export function requestSpan(name = 'http request'): Span {
  return trace.getTracer('test').startSpan(name);
}

export function traceparentOf(spanContext: SpanContext): string {
  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED) === 1 ? '01' : '00';
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export type ParsedTraceparent = { traceId: string; spanId: string; sampled: boolean };

export function parseTraceparent(value: string | null | undefined): ParsedTraceparent | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value ?? '');
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], sampled: (parseInt(match[3], 16) & TraceFlags.SAMPLED) === 1 };
}

export const activeContextOf = (span: Span) => trace.setSpan(context.active(), span);
