import { randomBytes, scryptSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { User } from '../src/entities';
import { createApp, FakeDataSource } from './support';

// Wrong-password/unknown-email and malformed-body 401s are covered in src/login.controller.spec.ts.
// This spec only proves the seeded credential issues a token the real AuthGuard accepts on a real route.
describe('POST /auth/login against protected routes', () => {
  let app: INestApplication;
  let db: FakeDataSource;

  beforeEach(async () => {
    ({ app, db } = await createApp({ login: true }));
    const salt = randomBytes(16).toString('hex');
    db.seed(User, {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'passageiro1@taxi.rio',
      password_hash: `${salt}:${scryptSync('taxi123', salt, 64).toString('hex')}`,
      sub: 'passageiro-1',
      role: 'passageiro',
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts the seeded credential and the issued token on GET /corridas', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'passageiro1@taxi.rio', password: 'taxi123' })
      .expect(200);
    expect(Object.keys(login.body)).toEqual(['token']);

    const corridas = await request(app.getHttpServer())
      .get('/corridas')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(corridas.body).toEqual([]);
  });
});
