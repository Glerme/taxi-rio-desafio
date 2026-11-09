import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { CorridaStatus, JwtClaims } from 'contracts';
import { CurrentUser, Roles } from './auth';
import { CorridasService, CreateCorrida } from './corridas.service';

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Body must be an object');
  return body as Record<string, unknown>;
}

@Controller('corridas')
@Roles('passageiro', 'motorista')
export class CorridasController {
  constructor(private readonly corridas: CorridasService) {}

  @Post()
  @Roles('passageiro')
  async create(@CurrentUser() user: JwtClaims, @Headers('idempotency-key') key: unknown, @Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    if (typeof key !== 'string' || !key.trim() || key.length > 255) throw new BadRequestException('Idempotency-Key is required and must be at most 255 characters');
    const body = objectBody(input);
    for (const field of ['origem', 'destino']) {
      if (typeof body[field] !== 'string' || !(body[field] as string).trim() || Buffer.byteLength(body[field] as string, 'utf8') > 65535) throw new BadRequestException(`${field} must be a nonempty string of at most 65535 bytes`);
    }
    const value: CreateCorrida = { origem: body.origem as string, destino: body.destino as string };
    const result = await this.corridas.create(user.sub, key, value);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.corrida;
  }

  @Patch(':id/status')
  @Roles('motorista')
  changeStatus(@Param('id', new ParseUUIDPipe()) id: string, @Body() input: unknown, @CurrentUser() user: JwtClaims) {
    const body = objectBody(input);
    if (!['aceita', 'em_andamento', 'finalizada'].includes(body.status as string)) throw new BadRequestException('Invalid status');
    return this.corridas.changeStatus(id, body.status as CorridaStatus, user.sub);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtClaims) {
    return this.corridas.get(id, user);
  }

  @Get()
  list(@CurrentUser() user: JwtClaims) { return this.corridas.list(user); }
}
