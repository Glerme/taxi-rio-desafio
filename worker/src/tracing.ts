import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'worker' }),
  traceExporter: new OTLPTraceExporter(),
  // AMQP propagation is explicit so each delivery has exactly one consumer span.
  instrumentations: [new MongoDBInstrumentation(), new IORedisInstrumentation(), new PinoInstrumentation()],
});
sdk.start();

export async function shutdownTracing(): Promise<void> {
  await sdk.shutdown().catch(() => undefined);
}
