import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1730000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE corridas (
      id char(36) NOT NULL PRIMARY KEY,
      passageiro_id varchar(255) NOT NULL,
      motorista_id varchar(255) NULL,
      origem text NOT NULL,
      destino text NOT NULL,
      status varchar(20) NOT NULL,
      version int NOT NULL DEFAULT 1,
      idempotency_key varchar(255) NOT NULL,
      request_hash char(64) NOT NULL,
      created_at datetime(3) NOT NULL,
      updated_at datetime(3) NOT NULL,
      UNIQUE KEY uq_corrida_idempotency (passageiro_id, idempotency_key)
    ) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    await queryRunner.query(`CREATE TABLE outbox (
      event_id char(36) NOT NULL PRIMARY KEY,
      routing_key varchar(64) NOT NULL,
      payload json NOT NULL,
      created_at datetime(3) NOT NULL,
      sent_at datetime(3) NULL,
      KEY idx_outbox_sent_at (sent_at)
    ) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox');
    await queryRunner.query('DROP TABLE corridas');
  }
}
