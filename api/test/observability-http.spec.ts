import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpDuration, httpRequests, metrics, observeHttp } from '../src/observability';
import { createApp, FakeDataSource, signJwt } from './support';

const passageiro = signJwt({ sub: 'p1', role: 'passageiro' });
const motorista = signJwt({ sub: 'm1', role: 'motorista' });

const until = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not met');
};

describe('HTTP metrics', () => {
  let app: INestApplication;
  let db: FakeDataSource;

  beforeEach(async () => {
    httpRequests.reset();
    httpDuration.reset();
    ({ app, db } = await createApp({ metrics: true, setup: (nest) => nest.use(observeHttp) }));
  });

  afterEach(async () => { await app.close(); });

  const server = () => app.getHttpServer();

  const create = () =>
    request(server()).post('/corridas').set('Authorization', `Bearer ${passageiro}`).set('Idempotency-Key', 'key-1').send({ origem: 'Centro', destino: 'Copacabana' });

  const samples = async () => (await httpRequests.get()).values;
  const sampleOf = (values: Awaited<ReturnType<typeof samples>>, method: string, route: string) =>
    values.find((sample) => sample.labels.method === method && sample.labels.route === route);

  it('labels requests with the route template instead of the concrete URL', async () => {
    const created = await create().expect(201);
    const id = created.body.id as string;
    await request(server()).patch(`/corridas/${id}/status`).set('Authorization', `Bearer ${motorista}`).send({ status: 'aceita' }).expect(200);
    await request(server()).get(`/corridas/${id}`).set('Authorization', `Bearer ${passageiro}`).expect(200);

    await until(async () => (await samples()).length >= 3);
    const values = await samples();

    expect(sampleOf(values, 'POST', '/corridas')).toMatchObject({ value: 1, labels: { status_code: '201' } });
    expect(sampleOf(values, 'PATCH', '/corridas/:id/status')).toMatchObject({ value: 1, labels: { status_code: '200' } });
    expect(sampleOf(values, 'GET', '/corridas/:id')).toMatchObject({ value: 1, labels: { status_code: '200' } });
    expect((httpRequests as unknown as { labelNames: string[] }).labelNames).toEqual(['method', 'route', 'status_code']);
    expect(values.some((sample) => String(sample.labels.route).includes(id))).toBe(false);
  });

  it('serves /metrics without a token and does not count itself', async () => {
    const response = await request(server()).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('http_requests_total');
    expect(await samples()).toEqual([]);
    expect((await metrics.getMetricsAsJSON()).map((metric) => metric.name)).toEqual(expect.arrayContaining([
      'http_requests_total',
      'http_request_duration_seconds',
    ]));
  });
});
