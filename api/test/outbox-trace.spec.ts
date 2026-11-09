import { context, type Span } from '@opentelemetry/api';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Outbox } from '../src/entities';
import { createApp, FakeDataSource, signJwt } from './support';
import { activeContextOf, parseTraceparent, requestSpan, startTestTracing, type RecordedSpan } from './trace-support';

const passageiro = signJwt({ sub: 'p1', role: 'passageiro' });
const motorista = signJwt({ sub: 'm1', role: 'motorista' });

describe('outbox trace context', () => {
  let app: INestApplication;
  let db: FakeDataSource;
  let active: Span | undefined;
  let tracing: { sdk: { shutdown(): Promise<void> }; spans: RecordedSpan[] };

  beforeAll(() => { tracing = startTestTracing(); });

  afterAll(async () => {
    await tracing.sdk.shutdown();
    context.disable();
  });

  beforeEach(async () => {
    active = undefined;
    ({ app, db } = await createApp({
      setup: (nest) => nest.use((_request: Request, _response: Response, next: NextFunction) => {
        if (!active) return next();
        context.with(activeContextOf(active), next);
      }),
    }));
  });

  afterEach(async () => { await app.close(); });

  const post = (key = 'key-1') =>
    request(app.getHttpServer()).post('/corridas').set('Authorization', `Bearer ${passageiro}`).set('Idempotency-Key', key).send({ origem: 'Centro', destino: 'Copacabana' });

  const patch = (id: string, status: string) =>
    request(app.getHttpServer()).patch(`/corridas/${id}/status`).set('Authorization', `Bearer ${motorista}`).send({ status });

  it('stores a valid W3C traceparent with the active trace_id on POST', async () => {
    active = requestSpan('POST /corridas');

    await post().expect(201);

    const [row] = db.rows(Outbox);
    const parsed = parseTraceparent(row.traceparent as string);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ traceId: active.spanContext().traceId, sampled: true });
    expect(row.tracestate).toBeNull();
  });

  it('stores the traceparent of the PATCH request and leaves a request without a span untraced', async () => {
    const created = await post().expect(201);
    expect(db.rows(Outbox)[0].traceparent).toBeNull();

    active = requestSpan('PATCH /corridas/:id/status');
    await patch(created.body.id as string, 'aceita').expect(200);

    const [, changed] = db.rows(Outbox);
    const parsed = parseTraceparent(changed.traceparent as string);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe(active.spanContext().traceId);
  });
});
