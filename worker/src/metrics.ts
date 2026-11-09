import { createServer, Server } from 'node:http';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const messagesTotal = new Counter({
  name: 'worker_messages_total', help: 'Settled worker deliveries', labelNames: ['outcome'], registers: [registry],
});
export const processingDuration = new Histogram({
  name: 'worker_processing_duration_seconds', help: 'Delivery receipt to ack or nack', registers: [registry],
});
export const eventLag = new Histogram({
  name: 'worker_event_lag_seconds', help: 'Event age when successfully processed',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120], registers: [registry],
});

export function startMetricsServer(): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end('ok');
    } else if (req.method === 'GET' && req.url === '/metrics') {
      void registry.metrics().then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      }).catch(() => res.writeHead(500).end());
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(Number(process.env.METRICS_PORT || 3001));
  return server;
}
