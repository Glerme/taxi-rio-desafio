import { Controller, Get, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoginController } from './login.controller';
import { Users1730000002000 } from './migrations/1730000002000-Users';
import { AuthGuard } from './auth';
import { CorridasController } from './corridas.controller';
import { CorridasService } from './corridas.service';
import { Corrida, Outbox, User } from './entities';
import { CacheService, OutboxRelay } from './infrastructure';
import { databaseLogger, MetricsController, observeHttp } from './observability';
import { OutboxTraceContext1730000001000 } from './migrations/1730000001000-OutboxTraceContext';
import { Initial1730000000000 } from './migrations/1730000000000-Initial';

@Controller()
class HealthController {
  @Get('health') health() { return { status: 'ok' }; }
}

@Module({
  imports: [TypeOrmModule.forRoot({
    type: 'mysql', host: process.env.MYSQL_HOST ?? 'localhost', port: Number(process.env.MYSQL_PORT ?? 3306),
    username: process.env.MYSQL_USER ?? 'taxi', password: process.env.MYSQL_PASSWORD ?? 'taxi', database: process.env.MYSQL_DATABASE ?? 'taxi',
    entities: [Corrida, Outbox, User], migrations: [Initial1730000000000, OutboxTraceContext1730000001000, Users1730000002000], migrationsRun: true, synchronize: false,
    logger: databaseLogger, charset: 'utf8mb4', timezone: 'Z', retryAttempts: 1,
  })],
  controllers: [LoginController, HealthController, MetricsController, CorridasController],
  providers: [CorridasService, CacheService, OutboxRelay, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(observeHttp).forRoutes('*path'); }
}
