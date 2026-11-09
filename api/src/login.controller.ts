import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { User } from './entities';

const deriveKey = promisify(scrypt);

@Controller('auth')
export class LoginController {
  private readonly privateKey = readFileSync(process.env.JWT_PRIVATE_KEY_PATH ?? '/keys/private.pem', 'utf8');
  private readonly missingUserSalt = randomBytes(16).toString('hex');

  constructor(private readonly db: DataSource) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<{ token: string }> {
    const invalid = () => new UnauthorizedException({ message: 'Credenciais inválidas' });
    if (!body || typeof body !== 'object' || !('email' in body) || !('password' in body)) throw invalid();
    const { email, password } = body;
    if (typeof email !== 'string' || !email.trim() || email.length > 255 ||
        typeof password !== 'string' || !password.trim() || password.length > 128) throw invalid();
    const user = await this.db.getRepository(User).findOneBy({ email: email.trim().toLowerCase() });
    const [salt, hash] = user ? user.password_hash.split(':') : [this.missingUserSalt, '00'.repeat(64)];
    const expected = Buffer.from(hash, 'hex');
    const actual = await deriveKey(password, salt, 64) as Buffer;
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!user || !matches) throw invalid();
    return { token: sign({ sub: user.sub, role: user.role }, this.privateKey, { algorithm: 'RS256', expiresIn: '8h' }) };
  }
}
