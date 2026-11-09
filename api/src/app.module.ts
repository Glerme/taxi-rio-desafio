import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './auth';
import { CorridasController } from './corridas.controller';
import { CorridasService } from './corridas.service';
import { Corrida, Outbox } from './entities';
import { CacheService, OutboxRelay } from './infrastructure';
import { Initial1730000000000 } from './migrations/1730000000000-Initial';

@Controller()
class HealthController {
  @Get('health') health() { return { status: 'ok' }; }
}

@Module({
  imports: [TypeOrmModule.forRoot({
    type: 'mysql', host: process.env.MYSQL_HOST ?? 'localhost', port: Number(process.env.MYSQL_PORT ?? 3306),
    username: process.env.MYSQL_USER ?? 'taxi', password: process.env.MYSQL_PASSWORD ?? 'taxi', database: process.env.MYSQL_DATABASE ?? 'taxi',
    entities: [Corrida, Outbox], migrations: [Initial1730000000000], migrationsRun: true, synchronize: false,
    charset: 'utf8mb4', timezone: 'Z', retryAttempts: 1,
  })],
  controllers: [HealthController, CorridasController],
  providers: [CorridasService, CacheService, OutboxRelay, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
