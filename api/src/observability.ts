import { Controller, Get, Header, type LoggerService } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import type { Logger as DatabaseLogger } from 'typeorm';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

// The OTel trace_id is the correlation_id across HTTP, outbox and worker logs.
export const logger = pino();
export const nestLogger: LoggerService = {
  log: (message: unknown, scope?: string) => logger.info({ context: scope }, String(message)),
  error: (message: unknown, stack?: string, scope?: string) => logger.error({ context: scope, stack }, String(message)),
  warn: (message: unknown, scope?: string) => logger.warn({ context: scope }, String(message)),
  debug: (message: unknown, scope?: string) => logger.debug({ context: scope }, String(message)),
  verbose: (message: unknown, scope?: string) => logger.trace({ context: scope }, String(message)),
};
export const databaseLogger: DatabaseLogger = {
  logQuery: () => undefined,
  logQueryError: error => logger.error({ err: error }, 'MySQL query failed'),
  logQuerySlow: duration => logger.warn({ duration_ms: duration }, 'Slow MySQL query'),
  logSchemaBuild: message => logger.info({ context: 'TypeORM' }, message),
  logMigration: message => logger.info({ context: 'TypeORM' }, message),
  log: (level, message: unknown) => logger[level === 'log' ? 'info' : level]({ context: 'TypeORM' }, String(message)),
};
export const metrics = new Registry();
collectDefaultMetrics({ register: metrics });
const labels = ['method', 'route', 'status_code'] as const;
export const httpRequests = new Counter({ name: 'http_requests_total', help: 'Completed HTTP requests', labelNames: labels, registers: [metrics] });
export const httpDuration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration in seconds', labelNames: labels, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [metrics] });
export const outboxPending = new Gauge({ name: 'outbox_pending', help: 'Unsent outbox rows', registers: [metrics] });
export const outboxOldestAge = new Gauge({ name: 'outbox_oldest_pending_age_seconds', help: 'Age of oldest unsent outbox row', registers: [metrics] });
export const outboxPublished = new Counter({ name: 'outbox_published_total', help: 'Confirmed outbox publications committed to MySQL', registers: [metrics] });
export const outboxErrors = new Counter({ name: 'outbox_publish_errors_total', help: 'Failed outbox publication attempts', registers: [metrics] });

export function observeHttp(request: Request, response: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  response.once('finish', context.bind(context.active(), () => {
    const route = typeof request.route?.path === 'string' ? `${request.baseUrl}${request.route.path}` : 'unmatched';
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const values = { method: request.method, route, status_code: String(response.statusCode) };
    if (route !== '/metrics') {
      httpRequests.inc(values);
      httpDuration.observe(values, duration);
    }
    logger.info({ ...values, duration_seconds: duration }, 'HTTP request');
  }));
  next();
}

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', metrics.contentType)
  get(): Promise<string> { return metrics.metrics(); }
}
