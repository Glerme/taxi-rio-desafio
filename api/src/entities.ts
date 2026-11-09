import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { CorridaEvent, CorridaStatus } from 'contracts';

@Entity('corridas')
@Index('uq_corrida_idempotency', ['passageiro_id', 'idempotency_key'], { unique: true })
export class Corrida {
  @PrimaryColumn({ type: 'char', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 255 }) passageiro_id!: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) motorista_id!: string | null;
  @Column({ type: 'text' }) origem!: string;
  @Column({ type: 'text' }) destino!: string;
  @Column({ type: 'varchar', length: 20 }) status!: CorridaStatus;
  @Column({ type: 'int', default: 1 }) version!: number;
  @Column({ type: 'varchar', length: 255 }) idempotency_key!: string;
  @Column({ type: 'char', length: 64 }) request_hash!: string;
  @Column({ type: 'datetime', precision: 3 }) created_at!: Date;
  @Column({ type: 'datetime', precision: 3 }) updated_at!: Date;
}

@Entity('outbox')
@Index('idx_outbox_sent_at', ['sent_at'])
export class Outbox {
  @PrimaryColumn({ type: 'char', length: 36 }) event_id!: string;
  @Column({ type: 'varchar', length: 64 }) routing_key!: CorridaEvent['type'];
  @Column({ type: 'varchar', length: 55, nullable: true }) traceparent!: string | null;
  @Column({ type: 'varchar', length: 512, nullable: true }) tracestate!: string | null;
  @Column({ type: 'json' }) payload!: CorridaEvent;
  @Column({ type: 'datetime', precision: 3 }) created_at!: Date;
  @Column({ type: 'datetime', precision: 3, nullable: true }) sent_at!: Date | null;
}
