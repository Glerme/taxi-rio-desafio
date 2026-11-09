import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { verify } from 'jsonwebtoken';
import type { Request } from 'express';
import type { JwtClaims, Role } from 'contracts';

type AuthRequest = Request & { user: JwtClaims };
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): JwtClaims => context.switchToHttp().getRequest<AuthRequest>().user);

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly publicKey = readFileSync(process.env.JWT_PUBLIC_KEY_PATH ?? '/keys/public.pem', 'utf8');
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [context.getHandler(), context.getClass()]);
    if (!roles) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException();
    try {
      const claims = verify(match[1], this.publicKey, { algorithms: ['RS256'] });
      if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255 || !['passageiro', 'motorista'].includes(claims.role)) {
        throw new Error('Invalid claims');
      }
      request.user = { sub: claims.sub, role: claims.role as Role };
    } catch {
      throw new UnauthorizedException();
    }
    if (!roles.includes(request.user.role)) throw new ForbiddenException();
    return true;
  }
}
