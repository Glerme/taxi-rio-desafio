import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, signJwt } from './support';

const passageiro = signJwt({ sub: 'p1', role: 'passageiro' });
const motorista = signJwt({ sub: 'm1', role: 'motorista' });
const noIdempotencyMetadata = (body: Record<string, unknown>) => {
  expect(body).not.toHaveProperty('idempotency_key');
  expect(body).not.toHaveProperty('request_hash');
  return body;
};

describe('corridas HTTP response masking', () => {
  let app: INestApplication;

  beforeEach(async () => { ({ app } = await createApp()); });
  afterEach(async () => { await app.close(); });

  it('never returns idempotency_key or request_hash from POST, PATCH, GET or list', async () => {
    const created = await request(app.getHttpServer()).post('/corridas')
      .set('Authorization', `Bearer ${passageiro}`).set('Idempotency-Key', 'key-1')
      .send({ origem: 'Centro', destino: 'Copacabana' }).expect(201);
    noIdempotencyMetadata(created.body);

    const id = created.body.id as string;
    const patched = await request(app.getHttpServer()).patch(`/corridas/${id}/status`)
      .set('Authorization', `Bearer ${motorista}`).send({ status: 'aceita' }).expect(200);
    noIdempotencyMetadata(patched.body);

    const fetched = await request(app.getHttpServer()).get(`/corridas/${id}`)
      .set('Authorization', `Bearer ${passageiro}`).expect(200);
    noIdempotencyMetadata(fetched.body);

    const listed = await request(app.getHttpServer()).get('/corridas')
      .set('Authorization', `Bearer ${passageiro}`).expect(200);
    expect(listed.body).toHaveLength(1);
    noIdempotencyMetadata(listed.body[0]);
  });
});
