import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Corrida, Outbox } from '../src/entities';
import { createApp, FakeCache, FakeDataSource, foreignPrivateKey, signJwt } from './support';

const passageiro = signJwt({ sub: 'p1', role: 'passageiro' });
const motorista = signJwt({ sub: 'm1', role: 'motorista' });
const otherPassageiro = signJwt({ sub: 'p2', role: 'passageiro' });

describe('corridas HTTP', () => {
  let app: INestApplication;
  let db: FakeDataSource;
  let cache: FakeCache;

  beforeEach(async () => {
    ({ app, db, cache } = await createApp());
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: object = { origem: 'Centro', destino: 'Copacabana' }, key = 'key-1', token = passageiro) =>
    request(app.getHttpServer()).post('/corridas').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);

  const patch = (id: string, status: string, token = motorista) =>
    request(app.getHttpServer()).patch(`/corridas/${id}/status`).set('Authorization', `Bearer ${token}`).send({ status });

  it('walks solicitada -> aceita -> em_andamento -> finalizada with versions and one outbox event per step', async () => {
    const created = await post().expect(201);
    expect(created.body).toMatchObject({ status: 'solicitada', version: 1, passageiro_id: 'p1', motorista_id: null });
    const id = created.body.id as string;

    const versions = [created.body.version as number];
    for (const [status, actor] of [['aceita', 'm1'], ['em_andamento', 'm1'], ['finalizada', 'm1']] as const) {
      const changed = await patch(id, status).expect(200);
      expect(changed.body.status).toBe(status);
      expect(changed.body.motorista_id).toBe(actor);
      versions.push(changed.body.version as number);
    }
    expect(versions).toEqual([1, 2, 3, 4]);

    const events = db.rows(Outbox).map((row) => row.payload as { event_id: string; type: string; version: number; status: string });
    expect(events.map((event) => [event.type, event.version, event.status])).toEqual([
      ['corrida.criada', 1, 'solicitada'],
      ['corrida.status_alterado', 2, 'aceita'],
      ['corrida.status_alterado', 3, 'em_andamento'],
      ['corrida.status_alterado', 4, 'finalizada'],
    ]);
    expect(new Set(events.map((event) => event.event_id)).size).toBe(4);
    expect(db.rows(Corrida)).toHaveLength(1);
    expect(db.rows(Corrida)[0].version).toBe(4);

    const fetched = await request(app.getHttpServer()).get(`/corridas/${id}`).set('Authorization', `Bearer ${passageiro}`).expect(200);
    expect(fetched.body).toMatchObject({ id, version: 4, status: 'finalizada' });
    expect(cache.values.has(`corrida:${id}`)).toBe(true);
  });

  it('answers 401 without a token', async () => {
    await request(app.getHttpServer()).post('/corridas').set('Idempotency-Key', 'key-1').send({ origem: 'A', destino: 'B' }).expect(401);
  });

  it('answers 401 for a token signed by the wrong key', async () => {
    const forged = signJwt({ sub: 'p1', role: 'passageiro' }, foreignPrivateKey);
    await post(undefined, 'key-1', forged).expect(401);
  });

  it('answers 403 when a motorista tries to create a corrida', async () => {
    await post(undefined, 'key-1', motorista).expect(403);
  });

  it('replays the same key and body without inserting a second ride or outbox event', async () => {
    const first = await post().expect(201);
    const second = await post().expect(201);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body).toEqual(first.body);
    expect(db.rows(Corrida)).toHaveLength(1);
    expect(db.rows(Outbox)).toHaveLength(1);
  });

  it('answers 422 when the same key is reused with a different body', async () => {
    await post().expect(201);
    await post({ origem: 'Centro', destino: 'Ipanema' }).expect(422);
    expect(db.rows(Corrida)).toHaveLength(1);
    expect(db.rows(Outbox)).toHaveLength(1);
  });

  it('re-reads the winning ride on a UNIQUE collision instead of answering 500', async () => {
    const winnerId = '11111111-1111-4111-8111-111111111111';
    db.beforeCorridaInsert = (candidate) => db.seed(Corrida, { ...candidate, id: winnerId });

    const response = await post().expect(201);

    expect(response.body.id).toBe(winnerId);
    expect(db.rows(Corrida)).toHaveLength(1);
    expect(db.rows(Corrida)[0].id).toBe(winnerId);
    // The simulated winner commit only seeds the ride; the losing insert must not add an event.
    expect(db.rows(Outbox)).toHaveLength(0);
  });

  it('writes the ride and its outbox event through the same transaction manager', async () => {
    await post().expect(201);

    expect(db.transactionManagers).toHaveLength(1);
    const transaction = db.transactionManagers[0];
    const rideInsert = db.inserts.find((insert) => insert.entity === Corrida);
    const outboxInsert = db.inserts.find((insert) => insert.entity === Outbox);

    expect(rideInsert?.manager).toBe(transaction);
    expect(outboxInsert?.manager).toBe(transaction);
    expect(outboxInsert?.row.created_at).toBe(rideInsert?.row.created_at);
    expect(outboxInsert?.row.routing_key).toBe('corrida.criada');
  });

  it('answers 409 on an invalid transition and leaves version and outbox untouched', async () => {
    const created = await post().expect(201);

    await patch(created.body.id as string, 'finalizada').expect(409);

    expect(db.rows(Corrida)[0].version).toBe(1);
    expect(db.rows(Corrida)[0].status).toBe('solicitada');
    expect(db.rows(Outbox)).toHaveLength(1);
  });

  it('does not leak another passenger ride through GET', async () => {
    const created = await post().expect(201);
    await request(app.getHttpServer()).get(`/corridas/${created.body.id}`).set('Authorization', `Bearer ${otherPassageiro}`).expect(403);
  });
});
