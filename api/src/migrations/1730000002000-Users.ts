import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { MigrationInterface, QueryRunner } from 'typeorm';

const deriveKey = promisify(scrypt);

export class Users1730000002000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // MySQL DDL commits independently; retries must preserve any already-seeded users.
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS users (
      id char(36) NOT NULL PRIMARY KEY,
      email varchar(255) NOT NULL,
      password_hash varchar(161) NOT NULL,
      sub varchar(255) NOT NULL,
      role varchar(20) NOT NULL,
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    for (const [email, sub, role] of [
      ['passageiro1@taxi.rio', 'passageiro-1', 'passageiro'],
      ['passageiro2@taxi.rio', 'passageiro-2', 'passageiro'],
      ['motorista1@taxi.rio', 'motorista-1', 'motorista'],
    ]) {
      const salt = randomBytes(16).toString('hex');
      const hash = await deriveKey('taxi123', salt, 64) as Buffer;
      await queryRunner.query(`INSERT INTO users (id, email, password_hash, sub, role)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE email = email`,
      [randomUUID(), email, `${salt}:${hash.toString('hex')}`, sub, role]);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE users');
  }
}
