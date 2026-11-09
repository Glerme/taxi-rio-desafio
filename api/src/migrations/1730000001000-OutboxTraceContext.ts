import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxTraceContext1730000001000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE outbox ADD traceparent varchar(55) NULL, ADD tracestate varchar(512) NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE outbox DROP COLUMN tracestate, DROP COLUMN traceparent');
  }
}
