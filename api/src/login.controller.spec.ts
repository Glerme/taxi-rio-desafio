import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import { scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verify } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource, QueryRunner } from 'typeorm';
import { AuthGuard, CurrentUser, Roles } from './auth';
import { LoginController } from './login.controller';
import { Users1730000002000 } from './migrations/1730000002000-Users';
import type { JwtClaims } from 'contracts';

@Controller('protected')
class ProtectedController {
  @Get()
  @Roles('passageiro', 'motorista')
  get(@CurrentUser() user: JwtClaims) { return user; }
}

describe('login and seeded credentials', () => {
  let app: INestApplication;
  const users = new Map<string, { email: string; password_hash: string; sub: string; role: string }>();
  const query = jest.fn(async (sql: string, values?: string[]) => {
    if (values && !users.has(values[1])) {
      const [, email, password_hash, sub, role] = values;
      users.set(email, { email, password_hash, sub, role });
    }
  });
  const oldPrivate = process.env.JWT_PRIVATE_KEY_PATH;
  const oldPublic = process.env.JWT_PUBLIC_KEY_PATH;

  beforeAll(async () => {
    process.env.JWT_PRIVATE_KEY_PATH = resolve(__dirname, '../../keys/private.pem');
    process.env.JWT_PUBLIC_KEY_PATH = resolve(__dirname, '../../keys/public.pem');
    const migration = new Users1730000002000();
    const runner = { query } as unknown as QueryRunner;
    await migration.up(runner);
    const original = [...users.values()].map(user => user.password_hash);
    await migration.up(runner);
    expect([...users.values()].map(user => user.password_hash)).toEqual(original);
    const module = await Test.createTestingModule({
      controllers: [LoginController, ProtectedController],
      providers: [
        { provide: DataSource, useValue: { getRepository: () => ({ findOneBy: async ({ email }: { email: string }) => users.get(email) ?? null }) } },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (oldPrivate === undefined) delete process.env.JWT_PRIVATE_KEY_PATH;
    else process.env.JWT_PRIVATE_KEY_PATH = oldPrivate;
    if (oldPublic === undefined) delete process.env.JWT_PUBLIC_KEY_PATH;
    else process.env.JWT_PUBLIC_KEY_PATH = oldPublic;
  });

  it.each([
    ['passageiro1@taxi.rio', 'passageiro-1', 'passageiro'],
    ['  Passageiro1@taxi.rio  ', 'passageiro-1', 'passageiro'],
    ['passageiro2@taxi.rio', 'passageiro-2', 'passageiro'],
    ['motorista1@taxi.rio', 'motorista-1', 'motorista'],
  ])('issues a guard-compatible 8h token for %s', async (email, sub, role) => {
    const result = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'taxi123' }).expect(200);
    expect(Object.keys(result.body)).toEqual(['token']);
    const claims = verify(result.body.token, readFileSync(process.env.JWT_PUBLIC_KEY_PATH!), { algorithms: ['RS256'] });
    expect(typeof claims).toBe('object');
    if (typeof claims === 'string') throw new Error('Unexpected JWT');
    expect(claims.exp! - claims.iat!).toBe(8 * 3600);
    await request(app.getHttpServer()).get('/protected').set('Authorization', `Bearer ${result.body.token}`).expect(200, { sub, role });
  });

  it.each([
    { email: 'passageiro1@taxi.rio', password: 'wrong' },
    { email: 'missing@taxi.rio', password: 'taxi123' },
    {}, { email: 12, password: 'taxi123' }, { email: 'a', password: '' },
    { email: ' ', password: 'taxi123' }, { email: 'a'.repeat(256), password: 'taxi123' },
    { email: 'a', password: 'a'.repeat(129) }, { email: 'a', password: 123 },
  ])('returns the same 401 for invalid credentials: %j', async body => {
    await request(app.getHttpServer()).post('/auth/login').send(body).expect(401, { message: 'Credenciais inválidas' });
  });

  it('seeds salted scrypt hashes, never plaintext', () => {
    expect(users.size).toBe(3);
    const salts = new Set<string>();
    for (const user of users.values()) {
      const [salt, hash] = user.password_hash.split(':');
      salts.add(salt);
      expect(scryptSync('taxi123', salt, 64).toString('hex')).toBe(hash);
    }
    expect(salts.size).toBe(3);
  });
});
