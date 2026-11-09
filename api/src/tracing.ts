import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'api',
  traceExporter: new OTLPTraceExporter(),
  logRecordProcessors: [],
  metricReaders: [],
  // AMQP is deliberately manual: the outbox persists the request context.
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new MySQL2Instrumentation(), new IORedisInstrumentation(), new PinoInstrumentation({ disableLogSending: true })],
});
sdk.start();
process.once('SIGTERM', () => { void sdk.shutdown().catch(() => undefined); });
