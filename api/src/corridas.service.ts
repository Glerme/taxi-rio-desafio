import { context, propagation } from '@opentelemetry/api';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { canTransition, corridaKey, CorridaEvent, CorridaStatus, JwtClaims, ROUTING_KEYS, setCorridaIfNewer } from 'contracts';
import { Corrida, Outbox } from './entities';
import { CacheService } from './infrastructure';

export type CorridaSnapshot = Pick<Corrida, 'id' | 'passageiro_id' | 'motorista_id' | 'status' | 'version'> & { updated_at: string };
export type CreateCorrida = { origem: string; destino: string };

@Injectable()
export class CorridasService {
  private readonly logger = new Logger(CorridasService.name);
  constructor(private readonly db: DataSource, private readonly cache: CacheService) {}

  private replay(corrida: Corrida, hash: string) {
    if (corrida.request_hash !== hash) throw new UnprocessableEntityException('Idempotency-Key already used with a different body');
    return { corrida, replayed: true };
  }

  private async enqueue(manager: EntityManager, corrida: Corrida, type: CorridaEvent['type']): Promise<void> {
    const event: CorridaEvent = {
      event_id: randomUUID(), type, corrida_id: corrida.id,
      passageiro_id: corrida.passageiro_id, motorista_id: corrida.motorista_id,
      status: corrida.status, version: corrida.version, occurred_at: corrida.updated_at.toISOString(),
    };
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    await manager.insert(Outbox, { traceparent: carrier.traceparent ?? null, tracestate: carrier.tracestate ?? null, event_id: event.event_id, routing_key: type, payload: event, created_at: corrida.updated_at, sent_at: null });
  }

  async create(passageiro: string, key: string, body: CreateCorrida) {
    const hash = createHash('sha256').update(JSON.stringify({ origem: body.origem, destino: body.destino })).digest('hex');
    const where = { passageiro_id: passageiro, idempotency_key: key };
    const existing = await this.db.getRepository(Corrida).findOneBy(where);
    if (existing) return this.replay(existing, hash);
    try {
      return await this.db.transaction(async manager => {
        const now = new Date();
        const corrida = manager.create(Corrida, { id: randomUUID(), passageiro_id: passageiro, motorista_id: null, ...body, status: 'solicitada', version: 1, idempotency_key: key, request_hash: hash, created_at: now, updated_at: now });
        await manager.insert(Corrida, corrida);
        await this.enqueue(manager, corrida, ROUTING_KEYS.CRIADA);
        return { corrida, replayed: false };
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY') {
        const winner = await this.db.getRepository(Corrida).findOneBy(where);
        if (winner) return this.replay(winner, hash);
      }
      throw error;
    }
  }

  async changeStatus(id: string, status: CorridaStatus, motorista: string): Promise<Corrida> {
    return this.db.transaction(async manager => {
      const corrida = await manager.findOneBy(Corrida, { id });
      if (!corrida) throw new NotFoundException();
      if (!canTransition(corrida.status, status)) throw new ConflictException('Invalid status transition');
      if (status !== 'aceita' && corrida.motorista_id !== motorista) throw new ForbiddenException();
      const previousVersion = corrida.version;
      corrida.status = status;
      corrida.version += 1;
      corrida.updated_at = new Date();
      if (status === 'aceita') corrida.motorista_id = motorista;
      const result = await manager.update(Corrida, { id, version: previousVersion }, {
        status, version: corrida.version, motorista_id: corrida.motorista_id, updated_at: corrida.updated_at,
      });
      if (result.affected !== 1) throw new ConflictException('Corrida changed concurrently');
      await this.enqueue(manager, corrida, ROUTING_KEYS.STATUS_ALTERADO);
      return (await manager.findOneByOrFail(Corrida, { id }));
    });
  }

  async get(id: string, user: JwtClaims): Promise<CorridaSnapshot> {
    let cached: string | null = null;
    try {
      cached = await this.cache.redis.get(corridaKey(id));
    } catch (error) {
      this.logger.warn(`Cache read failed; using MySQL: ${error instanceof Error ? error.message : String(error)}`);
    }
    let snapshot: CorridaSnapshot;
    if (cached) snapshot = JSON.parse(cached) as CorridaSnapshot;
    else {
      const corrida = await this.db.getRepository(Corrida).findOneBy({ id });
      if (!corrida) throw new NotFoundException();
      snapshot = { id: corrida.id, passageiro_id: corrida.passageiro_id, motorista_id: corrida.motorista_id, status: corrida.status, version: corrida.version, updated_at: corrida.updated_at.toISOString() };
      try {
        await setCorridaIfNewer(this.cache.redis, snapshot);
      } catch (error) {
        this.logger.warn(`Cache write failed; returning MySQL snapshot: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (user.role === 'passageiro' && snapshot.passageiro_id !== user.sub) throw new ForbiddenException();
    return snapshot;
  }

  list(user: JwtClaims): Promise<Corrida[]> {
    return this.db.getRepository(Corrida).find({
      where: user.role === 'passageiro' ? { passageiro_id: user.sub } : [{ status: 'solicitada' }, { motorista_id: user.sub }],
      order: { created_at: 'DESC' },
    });
  }
}
