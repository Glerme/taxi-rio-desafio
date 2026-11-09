import 'reflect-metadata';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { AuthGuard } from '../src/auth';
import { CorridasController } from '../src/corridas.controller';
import { CorridasService } from '../src/corridas.service';
import { Corrida, Outbox } from '../src/entities';
import { LoginController } from '../src/login.controller';
import { CacheService } from '../src/infrastructure';
import { MetricsController } from '../src/observability';

type EntityClass = new () => any;
type Row = Record<string, any>;

export type Insert = { manager: FakeManager; entity: EntityClass; row: Row };

const keysDir = join(__dirname, '..', '..', 'keys');
const repoPrivateKey = readFileSync(join(keysDir, 'private.pem'), 'utf8');
export const publicKeyPath = join(keysDir, 'public.pem');
export const foreignPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const base64url = (value: string) => Buffer.from(value).toString('base64url');

export function signJwt(claims: { sub: string; role: string }, privateKey = repoPrivateKey): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  signer.end();
  return `${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof FindOperator) {
      if (value.type === 'isNull') return row[key] === null || row[key] === undefined;
      throw new Error(`Fake datasource does not support FindOperator ${value.type}`);
    }
    return row[key] === value;
  });
}

class FakeManager {
  constructor(private readonly db: FakeDataSource) {}

  create(entity: EntityClass, value: Row): Row {
    return Object.assign(new entity(), value);
  }

  async insert(entity: EntityClass, value: Row): Promise<{ identifiers: never[] }> {
    const row: Row = { ...value };
    const table = this.db.tableOf(entity);
    if (entity === Corrida) {
      // Lets a test simulate a competing request committing between our read and insert.
      const hook = this.db.beforeCorridaInsert;
      this.db.beforeCorridaInsert = undefined;
      hook?.(row);
      if (table.some((existing) => existing.passageiro_id === row.passageiro_id && existing.idempotency_key === row.idempotency_key)) {
        throw new QueryFailedError('INSERT INTO corridas', [], { code: 'ER_DUP_ENTRY' } as unknown as Error);
      }
    }
    table.push(row);
    this.db.inserts.push({ manager: this, entity, row });
    return { identifiers: [] };
  }

  async findOneBy(entity: EntityClass, where: Row): Promise<Row | undefined> {
    const found = this.db.tableOf(entity).find((row) => matches(row, where));
    return found && { ...found };
  }

  async findOneByOrFail(entity: EntityClass, where: Row): Promise<Row> {
    const found = await this.findOneBy(entity, where);
    if (!found) throw new Error('Entity not found');
    return found;
  }

  async update(entity: EntityClass, where: Row, patch: Row): Promise<{ affected: number }> {
    const hook = this.db.beforeUpdate;
    this.db.beforeUpdate = undefined;
    hook?.(entity, where);
    const rows = this.db.tableOf(entity).filter((row) => matches(row, where));
    for (const row of rows) Object.assign(row, patch);
    return { affected: rows.length };
  }

  getRepository(entity: EntityClass) {
    return {
      findOneBy: (where: Row) => this.findOneBy(entity, where),
      find: async (options: { where?: Row | Row[]; order?: Record<string, 'ASC' | 'DESC'> } = {}) => {
        const conditions = Array.isArray(options.where) ? options.where : options.where ? [options.where] : [{}];
        const rows = this.db.tableOf(entity).filter((row) => conditions.some((where) => matches(row, where)));
        const [column, direction] = Object.entries(options.order ?? {})[0] ?? [];
        if (column) rows.sort((a, b) => (direction === 'DESC' ? -1 : 1) * (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0));
        return rows.map((row) => ({ ...row }));
      },
      createQueryBuilder: (_alias?: string) => {
        let where: Row = {};
        let take = Number.POSITIVE_INFINITY;
        const selects: { expression: string; alias?: string }[] = [];
        const builder = {
          where: (value: Row) => { where = value; return builder; },
          orderBy: (_column: string, _direction?: 'ASC' | 'DESC') => builder,
          take: (value: number) => { take = value; return builder; },
          setLock: (_mode: string) => builder,
          setOnLocked: (_mode: string) => builder,
          select: (expression: string, alias?: string) => { selects.push({ expression, alias }); return builder; },
          addSelect: (expression: string, alias?: string) => { selects.push({ expression, alias }); return builder; },
          getMany: async (): Promise<Row[]> => this.db.tableOf(entity)
            .filter((row) => matches(row, where))
            .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
            .slice(0, take)
            .map((row) => ({ ...row })),
          // Enough of TypeORM's raw aggregates for the relay gauges: COUNT(*) and MIN(column).
          getRawOne: async (): Promise<Row | undefined> => {
            const rows = this.db.tableOf(entity).filter((row) => matches(row, where));
            const raw: Row = {};
            for (const { expression, alias } of selects) {
              const count = /^COUNT\(\*\)$/i.test(expression.trim());
              const min = /^MIN\((?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\)$/i.exec(expression.trim());
              if (count) raw[alias ?? 'count'] = String(rows.length);
              else if (min) {
                const values = rows.map((row) => row[min[1]]).filter((value) => value !== null && value !== undefined);
                raw[alias ?? min[1]] = values.length ? values.reduce((left, right) => (left < right ? left : right)) : null;
              } else throw new Error(`Fake datasource does not support select ${expression}`);
            }
            return raw;
          },
        };
        return builder;
      },
    };
  }
}

export class FakeDataSource {
  readonly inserts: Insert[] = [];
  readonly transactionManagers: FakeManager[] = [];
  beforeCorridaInsert?: (row: Row) => void;
  beforeUpdate?: (entity: EntityClass, where: Row) => void;
  private readonly tables = new Map<EntityClass, Row[]>();

  tableOf(entity: EntityClass): Row[] {
    let table = this.tables.get(entity);
    if (!table) this.tables.set(entity, (table = []));
    return table;
  }

  rows(entity: EntityClass): Row[] {
    return this.tableOf(entity);
  }

  seed(entity: EntityClass, row: Row): void {
    this.tableOf(entity).push({ ...row });
  }

  getRepository(entity: EntityClass) {
    return new FakeManager(this).getRepository(entity);
  }

  async transaction<T>(run: (manager: FakeManager) => Promise<T>): Promise<T> {
    const manager = new FakeManager(this);
    this.transactionManagers.push(manager);
    return run(manager);
  }
}

export class FakeCache {
  readonly values = new Map<string, string>();
  readonly redis = {
    get: async (key: string) => this.values.get(key) ?? null,
    eval: async (_script: string, _numKeys: number, key: string, version: number, payload: string) => {
      const current = this.values.get(key);
      if (current && (JSON.parse(current) as { version: number }).version >= version) return 0;
      this.values.set(key, payload);
      return 1;
    },
  };
}

export type TestApp = { app: INestApplication; db: FakeDataSource; cache: FakeCache };

export type CreateAppOptions = {
  metrics?: boolean;
  login?: boolean;
  // Runs before app.init() so tests can register middleware ahead of the route table.
  setup?: (app: INestApplication) => void;
};

export async function createApp(options: CreateAppOptions = {}): Promise<TestApp> {
  process.env.JWT_PUBLIC_KEY_PATH = publicKeyPath;
  if (options.login) process.env.JWT_PRIVATE_KEY_PATH = join(keysDir, 'private.pem');
  const db = new FakeDataSource();
  const cache = new FakeCache();
  const moduleRef = await Test.createTestingModule({
    controllers: [
      CorridasController,
      ...(options.metrics ? [MetricsController] : []),
      ...(options.login ? [LoginController] : []),
    ],
    providers: [
      CorridasService,
      { provide: DataSource, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  options.setup?.(app);
  await app.init();
  return { app, db, cache };
}
